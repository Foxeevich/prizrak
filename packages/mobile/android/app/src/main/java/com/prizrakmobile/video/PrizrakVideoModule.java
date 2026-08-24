package com.prizrakmobile.video;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.opengl.EGLSurface;
import android.opengl.Matrix;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.view.Surface;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Видеодвижок звонка Prizrak. Камера (Camera2) → SurfaceTexture → GL-проход
 * (поворот в портрет + зеркало фронталки) → VP8-энкодер (MediaCodec) → кадры в JS.
 * Приём: decodeFrame → VP8-декодер → рендер на Surface (PrizrakVideoView role="remote").
 */
public class PrizrakVideoModule extends ReactContextBaseJavaModule {
  private static final String VP8 = "video/x-vnd.on2.vp8";
  public static PrizrakVideoModule instance;

  private final ReactApplicationContext ctx;

  // Портретный размер кодируемого видео (телефон держат вертикально).
  private final int outW = 480, outH = 640;
  // Разрешение сенсора, которое запрашиваем у камеры (ландшафт).
  private final int camW = 640, camH = 480;
  private boolean front = true;
  private int sensorOrientation = 270;

  // Захват + GL
  private HandlerThread glThread;
  private Handler glHandler;
  private CameraDevice camera;
  private CameraCaptureSession session;
  private MediaCodec encoder;
  private Surface encoderInput;
  private EglCore egl;
  private GlRect glRect;
  private int oesTex;
  private SurfaceTexture cameraTex;
  private Surface cameraSurface;
  private EGLSurface encoderEgl;
  private EGLSurface previewEgl;
  private volatile Surface localSurface;
  private final float[] stMatrix = new float[16];
  private final float[] mvp = new float[16];
  private volatile boolean capturing = false;

  // Декод
  private volatile Surface remoteSurface;
  private MediaCodec decoder;
  private int decW = 0, decH = 0;
  private long decPts = 0;
  private final Object decLock = new Object();

  public PrizrakVideoModule(ReactApplicationContext c) {
    super(c);
    this.ctx = c;
    instance = this;
  }

  @NonNull
  @Override
  public String getName() {
    return "PrizrakVideo";
  }

  private void emit(String ev, String data) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(ev, data);
    } catch (Exception ignored) {}
  }

  public void setSurface(String role, Surface s) {
    if ("remote".equals(role)) {
      synchronized (decLock) { remoteSurface = s; releaseDecoder(); }
    } else {
      localSurface = s;
      if (capturing && glHandler != null) glHandler.post(this::setupPreviewSurface);
    }
  }

  // ── Захват ────────────────────────────────────────────────────────────────
  @ReactMethod
  public void startCapture(String facing, Promise promise) {
    if (capturing) { promise.resolve(true); return; }
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("no_camera_perm", "Нет доступа к камере");
      return;
    }
    front = !"back".equals(facing);
    glThread = new HandlerThread("prizrak-gl");
    glThread.start();
    glHandler = new Handler(glThread.getLooper());
    glHandler.post(() -> {
      try {
        setupEncoderAndGl();
        openCamera();
        capturing = true;
        promise.resolve(true);
      } catch (Throwable e) {
        emit("PrizrakVideoError", "start: " + e.getMessage());
        promise.reject("video_start", e.getMessage(), e);
      }
    });
  }

  private void setupEncoderAndGl() throws Exception {
    // Энкодер VP8 (портрет) с input surface.
    MediaFormat fmt = MediaFormat.createVideoFormat(VP8, outW, outH);
    fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    fmt.setInteger(MediaFormat.KEY_BIT_RATE, 700_000);
    fmt.setInteger(MediaFormat.KEY_FRAME_RATE, 15);
    fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
    encoder = MediaCodec.createEncoderByType(VP8);
    encoder.setCallback(new MediaCodec.Callback() {
      @Override public void onInputBufferAvailable(@NonNull MediaCodec c, int i) {}
      @Override public void onOutputBufferAvailable(@NonNull MediaCodec c, int index, @NonNull MediaCodec.BufferInfo info) {
        try {
          ByteBuffer buf = c.getOutputBuffer(index);
          if (buf != null && info.size > 0) {
            buf.position(info.offset);
            buf.limit(info.offset + info.size);
            byte[] data = new byte[info.size];
            buf.get(data);
            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
            emit("PrizrakVideoFrame", (key ? "K" : "D") + Base64.encodeToString(data, Base64.NO_WRAP));
          }
          c.releaseOutputBuffer(index, false);
        } catch (Throwable ignored) {}
      }
      @Override public void onError(@NonNull MediaCodec c, @NonNull MediaCodec.CodecException e) { emit("PrizrakVideoError", "enc: " + e.getMessage()); }
      @Override public void onOutputFormatChanged(@NonNull MediaCodec c, @NonNull MediaFormat f) {}
    }, glHandler);
    encoder.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
    encoderInput = encoder.createInputSurface();
    encoder.start();
    emit("PrizrakVideoConfig", outW + "x" + outH);

    // GL-контекст + текстура камеры.
    egl = new EglCore();
    encoderEgl = egl.createWindowSurface(encoderInput);
    egl.makeCurrent(encoderEgl);
    glRect = new GlRect();
    oesTex = glRect.createOesTexture();
    cameraTex = new SurfaceTexture(oesTex);
    cameraTex.setDefaultBufferSize(camW, camH);
    cameraTex.setOnFrameAvailableListener(st -> { if (glHandler != null) glHandler.post(this::drawFrame); });
    cameraSurface = new Surface(cameraTex);
    setupPreviewSurface();
  }

  private void setupPreviewSurface() {
    try {
      if (egl == null) return;
      if (previewEgl != null) { egl.releaseSurface(previewEgl); previewEgl = null; }
      if (localSurface != null) previewEgl = egl.createWindowSurface(localSurface);
    } catch (Throwable e) { emit("PrizrakVideoError", "preview: " + e.getMessage()); }
  }

  // MVP: поворот геометрии в портрет (−90° к прежней формуле = поворот кадра по часовой).
  // mirror=true — горизонтальное зеркало (для локального превью, «как в зеркале»);
  // для передаваемого потока mirror=false (собеседник видит нас не зеркально).
  private void buildMvp(boolean mirror) {
    int rot = front ? ((360 - sensorOrientation - 90 + 720) % 360)
                    : ((sensorOrientation - 90 + 720) % 360);
    Matrix.setIdentityM(mvp, 0);
    Matrix.rotateM(mvp, 0, rot, 0, 0, 1);
    if (mirror) Matrix.scaleM(mvp, 0, -1, 1, 1);
  }

  private void drawFrame() {
    try {
      if (cameraTex == null || egl == null) return;
      cameraTex.updateTexImage();
      cameraTex.getTransformMatrix(stMatrix);
      long ts = cameraTex.getTimestamp();
      // 1) в энкодер (портрет outW×outH), БЕЗ зеркала — собеседник видит нас не зеркально
      buildMvp(false);
      egl.makeCurrent(encoderEgl);
      glRect.draw(oesTex, mvp, stMatrix, outW, outH);
      egl.setPresentationTime(encoderEgl, ts);
      egl.swapBuffers(encoderEgl);
      // 2) в локальное превью — С зеркалом для фронталки («селфи»-вид)
      if (previewEgl != null) {
        buildMvp(front);
        egl.makeCurrent(previewEgl);
        glRect.draw(oesTex, mvp, stMatrix, outW, outH);
        egl.swapBuffers(previewEgl);
      }
    } catch (Throwable e) {
      emit("PrizrakVideoError", "draw: " + e.getMessage());
    }
  }

  private String pickCamera(CameraManager mgr) throws CameraAccessException {
    String fallback = null;
    for (String id : mgr.getCameraIdList()) {
      CameraCharacteristics ch = mgr.getCameraCharacteristics(id);
      Integer f = ch.get(CameraCharacteristics.LENS_FACING);
      if (fallback == null) fallback = id;
      if (f == null) continue;
      boolean match = front ? (f == CameraCharacteristics.LENS_FACING_FRONT) : (f == CameraCharacteristics.LENS_FACING_BACK);
      if (match) {
        Integer so = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
        if (so != null) sensorOrientation = so;
        return id;
      }
    }
    return fallback;
  }

  private void openCamera() throws Exception {
    CameraManager mgr = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
    String id = pickCamera(mgr);
    if (id == null) throw new Exception("камера не найдена");
    // noinspection MissingPermission
    mgr.openCamera(id, new CameraDevice.StateCallback() {
      @Override public void onOpened(@NonNull CameraDevice device) { camera = device; createSession(); }
      @Override public void onDisconnected(@NonNull CameraDevice device) { device.close(); camera = null; }
      @Override public void onError(@NonNull CameraDevice device, int error) { emit("PrizrakVideoError", "cam: " + error); device.close(); camera = null; }
    }, glHandler);
  }

  private void createSession() {
    try {
      if (camera == null || cameraSurface == null) return;
      if (session != null) { try { session.close(); } catch (Throwable ignored) {} session = null; }
      List<Surface> targets = new ArrayList<>();
      targets.add(cameraSurface); // камера рисует в SurfaceTexture (GL сам раздаёт в энкодер/превью)
      camera.createCaptureSession(targets, new CameraCaptureSession.StateCallback() {
        @Override public void onConfigured(@NonNull CameraCaptureSession s) {
          session = s;
          try {
            CaptureRequest.Builder req = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            req.addTarget(cameraSurface);
            req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            s.setRepeatingRequest(req.build(), null, glHandler);
          } catch (Throwable e) { emit("PrizrakVideoError", "req: " + e.getMessage()); }
        }
        @Override public void onConfigureFailed(@NonNull CameraCaptureSession s) { emit("PrizrakVideoError", "session configure failed"); }
      }, glHandler);
    } catch (Throwable e) { emit("PrizrakVideoError", "session: " + e.getMessage()); }
  }

  @ReactMethod
  public void switchCamera(Promise promise) {
    if (!capturing) { if (promise != null) promise.resolve(false); return; }
    front = !front;
    if (glHandler != null) glHandler.post(() -> {
      try {
        if (session != null) { session.close(); session = null; }
        if (camera != null) { camera.close(); camera = null; }
        openCamera();
      } catch (Throwable e) { emit("PrizrakVideoError", "switch: " + e.getMessage()); }
    });
    if (promise != null) promise.resolve(true);
  }

  @ReactMethod
  public void stopCapture(Promise promise) {
    capturing = false;
    if (glHandler != null) {
      glHandler.post(() -> {
        try { if (session != null) session.close(); } catch (Throwable ignored) {}
        session = null;
        try { if (camera != null) camera.close(); } catch (Throwable ignored) {}
        camera = null;
        try { if (encoder != null) { encoder.stop(); encoder.release(); } } catch (Throwable ignored) {}
        encoder = null;
        try { if (cameraSurface != null) cameraSurface.release(); } catch (Throwable ignored) {}
        try { if (cameraTex != null) cameraTex.release(); } catch (Throwable ignored) {}
        cameraSurface = null; cameraTex = null;
        try { if (egl != null) { egl.releaseSurface(encoderEgl); egl.releaseSurface(previewEgl); egl.release(); } } catch (Throwable ignored) {}
        egl = null; encoderEgl = null; previewEgl = null; encoderInput = null;
      });
    }
    HandlerThread t = glThread; glThread = null;
    if (t != null) t.quitSafely();
    synchronized (decLock) { releaseDecoder(); }
    if (promise != null) promise.resolve(true);
  }

  // ── Декод входящего видео ──────────────────────────────────────────────────
  @ReactMethod
  public void decodeFrame(String b64, boolean key, int w, int h) {
    synchronized (decLock) {
      try {
        if (remoteSurface == null) return;
        if (decoder == null || decW != w || decH != h) { if (!ensureDecoder(w, h)) return; }
        byte[] data = Base64.decode(b64, Base64.NO_WRAP);
        int inIdx = decoder.dequeueInputBuffer(8000);
        if (inIdx >= 0) {
          ByteBuffer ib = decoder.getInputBuffer(inIdx);
          if (ib != null) { ib.clear(); ib.put(data); decoder.queueInputBuffer(inIdx, 0, data.length, decPts, key ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0); decPts += 66000; }
        }
        MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
        int outIdx = decoder.dequeueOutputBuffer(bi, 0);
        while (outIdx >= 0) { decoder.releaseOutputBuffer(outIdx, true); outIdx = decoder.dequeueOutputBuffer(bi, 0); }
      } catch (Throwable e) { emit("PrizrakVideoError", "dec: " + e.getMessage()); releaseDecoder(); }
    }
  }

  private boolean ensureDecoder(int w, int h) {
    try {
      releaseDecoder();
      if (remoteSurface == null || w <= 0 || h <= 0) return false;
      MediaFormat f = MediaFormat.createVideoFormat(VP8, w, h);
      decoder = MediaCodec.createDecoderByType(VP8);
      decoder.configure(f, remoteSurface, null, 0);
      decoder.start();
      decW = w; decH = h; decPts = 0;
      return true;
    } catch (Throwable e) { emit("PrizrakVideoError", "decInit: " + e.getMessage()); decoder = null; return false; }
  }

  private void releaseDecoder() {
    try { if (decoder != null) { decoder.stop(); decoder.release(); } } catch (Throwable ignored) {}
    decoder = null; decW = 0; decH = 0;
  }

  @ReactMethod public void addListener(String eventName) {}
  @ReactMethod public void removeListeners(double count) {}
}
