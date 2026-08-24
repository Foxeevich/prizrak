package com.prizrakmobile.video;

import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.view.Surface;

/** Минимальный EGL14-контекст (по мотивам Grafika, Apache 2.0). */
public class EglCore {
  private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
  private EGLContext context = EGL14.EGL_NO_CONTEXT;
  private EGLConfig config;

  public EglCore() {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] ver = new int[2];
    EGL14.eglInitialize(display, ver, 0, ver, 1);
    int[] attribs = {
        EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_ALPHA_SIZE, 8,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        0x3142 /* EGL_RECORDABLE_ANDROID */, 1,
        EGL14.EGL_NONE
    };
    EGLConfig[] cfgs = new EGLConfig[1];
    int[] num = new int[1];
    EGL14.eglChooseConfig(display, attribs, 0, cfgs, 0, cfgs.length, num, 0);
    config = cfgs[0];
    int[] ctxAttribs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
    context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, ctxAttribs, 0);
  }

  public EGLSurface createWindowSurface(Surface surface) {
    int[] attribs = {EGL14.EGL_NONE};
    return EGL14.eglCreateWindowSurface(display, config, surface, attribs, 0);
  }

  public void makeCurrent(EGLSurface s) {
    EGL14.eglMakeCurrent(display, s, s, context);
  }

  public boolean swapBuffers(EGLSurface s) {
    return EGL14.eglSwapBuffers(display, s);
  }

  public void setPresentationTime(EGLSurface s, long nsecs) {
    EGLExt.eglPresentationTimeANDROID(display, s, nsecs);
  }

  public void releaseSurface(EGLSurface s) {
    if (s != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, s);
  }

  public void release() {
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
      EGL14.eglDestroyContext(display, context);
      EGL14.eglTerminate(display);
    }
    display = EGL14.EGL_NO_DISPLAY;
    context = EGL14.EGL_NO_CONTEXT;
  }
}
