package com.prizrakmobile.video;

import androidx.annotation.NonNull;

import com.facebook.react.uimanager.SimpleViewManager;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;

/** RN-компонент <PrizrakVideoView role="local|remote" />. */
public class PrizrakVideoViewManager extends SimpleViewManager<PrizrakVideoView> {
  @NonNull
  @Override
  public String getName() {
    return "PrizrakVideoView";
  }

  @NonNull
  @Override
  protected PrizrakVideoView createViewInstance(@NonNull ThemedReactContext reactContext) {
    return new PrizrakVideoView(reactContext);
  }

  @ReactProp(name = "role")
  public void setRole(PrizrakVideoView view, String role) {
    view.setRole(role);
  }
}
