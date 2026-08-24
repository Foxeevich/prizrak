package com.prizrakmobile.audio;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import io.github.jaredmdobson.concentus.OpusApplication;
import io.github.jaredmdobson.concentus.OpusDecoder;
import io.github.jaredmdobson.concentus.OpusEncoder;
import io.github.jaredmdobson.concentus.OpusSignal;

/**
 * Нативный аудиодвижок звонка Prizrak.
 *  - Захват микрофона (AudioRecord) → Opus 20мс-кадры (Concentus) → событие
 *    "PrizrakOpusFrame" (base64) в JS, где кадр пакуется/шифруется и идёт в relay.
 *  - Приём: playFrame(base64 Opus) → декод → воспроизведение (AudioTrack).
 * Формат совместим с десктопом (WebCodecs Opus, 48кГц моно, 20мс).
 */
public class PrizrakAudioModule extends ReactContextBaseJavaModule {
  private static final int SAMPLE_RATE = 48000;
  private static final int CHANNELS = 1;
  private static final int FRAME_SAMPLES = 960; // 20мс @ 48кГц

  private final ReactApplicationContext ctx;
  private volatile boolean capturing = false;
  private volatile boolean muted = false;
  private Thread captureThread;
  private AudioRecord recorder;
  private AudioTrack track;
  private OpusEncoder encoder;
  private OpusDecoder decoder;
  private final Object decLock = new Object();

  public PrizrakAudioModule(ReactApplicationContext context) {
    super(context);
    this.ctx = context;
  }

  @NonNull
  @Override
  public String getName() {
    return "PrizrakAudio";
  }

  private void emit(String event, String data) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(event, data);
    } catch (Exception ignored) {}
  }

  @ReactMethod
  public void start(Promise promise) {
    if (capturing) { promise.resolve(true); return; }
    try {
      encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP);
      encoder.setBitrate(32000);
      encoder.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE);
      encoder.setUseDTX(false);
      synchronized (decLock) { decoder = new OpusDecoder(SAMPLE_RATE, CHANNELS); }

      // Плеер (динамик/наушник).
      int outMin = AudioTrack.getMinBufferSize(SAMPLE_RATE,
          AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
      track = new AudioTrack(AudioManager.STREAM_VOICE_CALL, SAMPLE_RATE,
          AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
          Math.max(outMin, FRAME_SAMPLES * 2 * 4), AudioTrack.MODE_STREAM);
      track.play();

      // Микрофон.
      int inMin = AudioRecord.getMinBufferSize(SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
      recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
          Math.max(inMin, FRAME_SAMPLES * 2 * 4));

      capturing = true;
      captureThread = new Thread(this::captureLoop, "prizrak-audio-capture");
      captureThread.start();
      promise.resolve(true);
    } catch (Throwable e) {
      stopInternal();
      promise.reject("audio_start", e.getMessage(), e);
    }
  }

  private void captureLoop() {
    short[] pcm = new short[FRAME_SAMPLES];
    byte[] out = new byte[4000];
    try {
      recorder.startRecording();
    } catch (Throwable e) {
      emit("PrizrakAudioError", "startRecording: " + e.getMessage());
      return;
    }
    while (capturing) {
      int read = 0;
      while (read < FRAME_SAMPLES && capturing) {
        int r = recorder.read(pcm, read, FRAME_SAMPLES - read);
        if (r <= 0) break;
        read += r;
      }
      if (read < FRAME_SAMPLES) continue;
      if (muted) continue; // не шлём звук, но сокет живёт
      try {
        int len = encoder.encode(pcm, 0, FRAME_SAMPLES, out, 0, out.length);
        if (len > 0) {
          String b64 = Base64.encodeToString(out, 0, len, Base64.NO_WRAP);
          emit("PrizrakOpusFrame", b64);
        }
      } catch (Throwable e) {
        emit("PrizrakAudioError", "encode: " + e.getMessage());
      }
    }
  }

  /** Воспроизвести входящий Opus-кадр (base64). */
  @ReactMethod
  public void playFrame(String b64) {
    if (!capturing || track == null) return;
    try {
      byte[] data = Base64.decode(b64, Base64.NO_WRAP);
      short[] pcm = new short[FRAME_SAMPLES];
      int samples;
      synchronized (decLock) {
        if (decoder == null) return;
        samples = decoder.decode(data, 0, data.length, pcm, 0, FRAME_SAMPLES, false);
      }
      if (samples > 0) track.write(pcm, 0, samples);
    } catch (Throwable ignored) {}
  }

  @ReactMethod
  public void setMuted(boolean m) { muted = m; }

  @ReactMethod
  public void stop(Promise promise) {
    stopInternal();
    if (promise != null) promise.resolve(true);
  }

  private void stopInternal() {
    capturing = false;
    try { if (captureThread != null) captureThread.join(300); } catch (Throwable ignored) {}
    captureThread = null;
    try { if (recorder != null) { recorder.stop(); recorder.release(); } } catch (Throwable ignored) {}
    recorder = null;
    try { if (track != null) { track.stop(); track.release(); } } catch (Throwable ignored) {}
    track = null;
    encoder = null;
    synchronized (decLock) { decoder = null; }
  }

  // Требуется RN для NativeEventEmitter — без реального содержимого.
  @ReactMethod public void addListener(String eventName) {}
  @ReactMethod public void removeListeners(double count) {}
}
