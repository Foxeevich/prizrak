package com.prizrakmobile.video;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/** Рисует внешнюю (камерную) OES-текстуру на полный экран с матрицей текстурных координат. */
public class GlRect {
  private static final String VS =
      "uniform mat4 uMVP;\n" +
      "uniform mat4 uTexMatrix;\n" +
      "attribute vec4 aPos;\n" +
      "attribute vec4 aTex;\n" +
      "varying vec2 vTex;\n" +
      "void main(){ gl_Position = uMVP * aPos; vTex = (uTexMatrix * aTex).xy; }\n";
  private static final String FS =
      "#extension GL_OES_EGL_image_external : require\n" +
      "precision mediump float;\n" +
      "varying vec2 vTex;\n" +
      "uniform samplerExternalOES sTex;\n" +
      "void main(){ gl_FragColor = texture2D(sTex, vTex); }\n";

  private final FloatBuffer pos;
  private final FloatBuffer tex;
  private final int prog;
  private final int aPos, aTex, uMVP, uTexMatrix, sTex;

  public GlRect() {
    float[] p = {-1, -1, 1, -1, -1, 1, 1, 1};
    float[] t = {0, 0, 1, 0, 0, 1, 1, 1};
    pos = ByteBuffer.allocateDirect(p.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    pos.put(p).position(0);
    tex = ByteBuffer.allocateDirect(t.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    tex.put(t).position(0);
    prog = link(VS, FS);
    aPos = GLES20.glGetAttribLocation(prog, "aPos");
    aTex = GLES20.glGetAttribLocation(prog, "aTex");
    uMVP = GLES20.glGetUniformLocation(prog, "uMVP");
    uTexMatrix = GLES20.glGetUniformLocation(prog, "uTexMatrix");
    sTex = GLES20.glGetUniformLocation(prog, "sTex");
  }

  private int link(String vs, String fs) {
    int v = compile(GLES20.GL_VERTEX_SHADER, vs);
    int f = compile(GLES20.GL_FRAGMENT_SHADER, fs);
    int p = GLES20.glCreateProgram();
    GLES20.glAttachShader(p, v);
    GLES20.glAttachShader(p, f);
    GLES20.glLinkProgram(p);
    return p;
  }

  private int compile(int type, String src) {
    int s = GLES20.glCreateShader(type);
    GLES20.glShaderSource(s, src);
    GLES20.glCompileShader(s);
    return s;
  }

  public void draw(int oesTexId, float[] mvp, float[] texMatrix, int vpW, int vpH) {
    GLES20.glViewport(0, 0, vpW, vpH);
    GLES20.glClearColor(0, 0, 0, 1);
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
    GLES20.glUseProgram(prog);
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexId);
    GLES20.glUniform1i(sTex, 0);
    GLES20.glUniformMatrix4fv(uMVP, 1, false, mvp, 0);
    GLES20.glUniformMatrix4fv(uTexMatrix, 1, false, texMatrix, 0);
    GLES20.glEnableVertexAttribArray(aPos);
    GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, pos);
    GLES20.glEnableVertexAttribArray(aTex);
    GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 0, tex);
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
    GLES20.glDisableVertexAttribArray(aPos);
    GLES20.glDisableVertexAttribArray(aTex);
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0);
  }

  public int createOesTexture() {
    int[] t = new int[1];
    GLES20.glGenTextures(1, t, 0);
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, t[0]);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
    return t[0];
  }
}
