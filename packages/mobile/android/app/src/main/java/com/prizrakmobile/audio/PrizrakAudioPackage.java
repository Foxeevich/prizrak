package com.prizrakmobile.audio;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import com.prizrakmobile.video.PrizrakVideoModule;
import com.prizrakmobile.video.PrizrakVideoViewManager;
import com.prizrakmobile.voice.PrizrakVoiceModule;
import com.prizrakmobile.note.PrizrakVideoNoteModule;
import com.prizrakmobile.note.PrizrakNoteViewManager;
import com.prizrakmobile.call.PrizrakCallModule;
import com.prizrakmobile.biometric.PrizrakBiometricModule;
import com.prizrakmobile.files.PrizrakFilesModule;

import java.util.ArrayList;
import java.util.List;

public class PrizrakAudioPackage implements ReactPackage {
  @NonNull
  @Override
  public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext reactContext) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new PrizrakAudioModule(reactContext));
    modules.add(new PrizrakVideoModule(reactContext));
    modules.add(new PrizrakVoiceModule(reactContext));
    modules.add(new PrizrakVideoNoteModule(reactContext));
    modules.add(new PrizrakCallModule(reactContext));
    modules.add(new PrizrakBiometricModule(reactContext));
    modules.add(new PrizrakFilesModule(reactContext));
    return modules;
  }

  @NonNull
  @Override
  public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext reactContext) {
    List<ViewManager> views = new ArrayList<>();
    views.add(new PrizrakVideoViewManager());
    views.add(new PrizrakNoteViewManager());
    return views;
  }
}
