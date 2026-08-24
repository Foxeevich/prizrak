package com.prizrakmobile.video;

import android.content.Context;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

import androidx.annotation.NonNull;

/**
 * SurfaceView для видео звонка. role="remote" — сюда декодер рисует видео собеседника;
 * role="local" — сюда Camera2 рисует локальное превью. Поверхность регистрируется в
 * PrizrakVideoModule по мере готовности.
 */
public class PrizrakVideoView extends SurfaceView implements SurfaceHolder.Callback {
  private String role = "remote";

  public PrizrakVideoView(Context context) {
    super(context);
    getHolder().addCallback(this);
  }

  public void setRole(String r) {
    this.role = r == null ? "remote" : r;
    // если поверхность уже создана — зарегистрировать сразу
    if (getHolder().getSurface() != null && getHolder().getSurface().isValid()) {
      register();
    }
  }

  private void register() {
    if (PrizrakVideoModule.instance != null) {
      PrizrakVideoModule.instance.setSurface(role, getHolder().getSurface());
    }
  }

  @Override public void surfaceCreated(@NonNull SurfaceHolder holder) { register(); }
  @Override public void surfaceChanged(@NonNull SurfaceHolder holder, int format, int width, int height) { register(); }
  @Override public void surfaceDestroyed(@NonNull SurfaceHolder holder) {
    if (PrizrakVideoModule.instance != null) PrizrakVideoModule.instance.setSurface(role, null);
  }
}
