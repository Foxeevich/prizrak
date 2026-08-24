package com.prizrakmobile.files;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Сохранение присланных файлов в системные «Загрузки» (Downloads).
 * API 29+ — через MediaStore.Downloads (разрешения не нужны);
 * старые Android (minSdk 23…28) — прямой файл в публичную папку Downloads
 * (WRITE_EXTERNAL_STORAGE объявлен в манифесте, до API 28 выдан при установке).
 */
public class PrizrakFilesModule extends ReactContextBaseJavaModule {
  public PrizrakFilesModule(ReactApplicationContext c) { super(c); }

  @NonNull
  @Override
  public String getName() { return "PrizrakFiles"; }

  /** Уникальное имя, если файл уже существует: song.mp3 → song (1).mp3 */
  private static File uniqueFile(File dir, String name) {
    File f = new File(dir, name);
    if (!f.exists()) return f;
    String base = name, ext = "";
    int dot = name.lastIndexOf('.');
    if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
    for (int i = 1; i < 1000; i++) {
      f = new File(dir, base + " (" + i + ")" + ext);
      if (!f.exists()) return f;
    }
    return new File(dir, base + "-" + System.currentTimeMillis() + ext);
  }

  @ReactMethod
  public void saveToDownloads(String filename, String mime, String base64, Promise promise) {
    try {
      byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
      String safe = (filename == null || filename.trim().isEmpty() ? "file" : filename).replaceAll("[/\\\\:*?\"<>|]+", "_");
      String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;

      if (Build.VERSION.SDK_INT >= 29) {
        ContentResolver cr = getReactApplicationContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
        v.put(MediaStore.Downloads.MIME_TYPE, type);
        v.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) { promise.reject("ERR", "MediaStore отказал"); return; }
        try (OutputStream os = cr.openOutputStream(uri)) {
          if (os == null) throw new Exception("Не открыть поток");
          os.write(bytes);
        }
        v.clear();
        v.put(MediaStore.Downloads.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        promise.resolve("Загрузки/" + safe);
      } else {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists()) dir.mkdirs();
        File out = uniqueFile(dir, safe);
        try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(bytes); }
        promise.resolve(out.getAbsolutePath());
      }
    } catch (Exception e) {
      promise.reject("ERR", e.getMessage());
    }
  }
}
