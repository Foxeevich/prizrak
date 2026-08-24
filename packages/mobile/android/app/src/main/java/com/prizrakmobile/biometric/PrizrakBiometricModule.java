package com.prizrakmobile.biometric;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

import java.util.concurrent.Executor;

/**
 * Биометрия для разблокировки приложения (отпечаток / лицо) через androidx BiometricPrompt.
 * Только локально на устройстве — ничего не уходит в сеть. Используется для App Lock
 * поверх PIN-кода: если биометрия включена, PIN спрашивать не обязательно.
 */
public class PrizrakBiometricModule extends ReactContextBaseJavaModule {
  private static final int AUTHENTICATORS =
      BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK;

  public PrizrakBiometricModule(ReactApplicationContext c) { super(c); }

  @NonNull
  @Override
  public String getName() { return "PrizrakBiometric"; }

  /** Доступна ли биометрия и есть ли зарегистрированные отпечатки/лицо. */
  @ReactMethod
  public void isAvailable(Promise promise) {
    try {
      BiometricManager bm = BiometricManager.from(getReactApplicationContext());
      int res = bm.canAuthenticate(AUTHENTICATORS);
      WritableMap map = Arguments.createMap();
      map.putBoolean("available", res == BiometricManager.BIOMETRIC_SUCCESS);
      map.putBoolean("noneEnrolled", res == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED);
      map.putInt("code", res);
      promise.resolve(map);
    } catch (Exception e) {
      promise.reject("ERR", e.getMessage());
    }
  }

  /** Показать системный диалог биометрии. resolve(true) при успехе, reject при ошибке/отмене. */
  @ReactMethod
  public void authenticate(final String title, final String subtitle, final String cancel, final Promise promise) {
    final FragmentActivity activity = (FragmentActivity) getCurrentActivity();
    if (activity == null) { promise.reject("NO_ACTIVITY", "Нет активности для показа диалога"); return; }
    activity.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        try {
          Executor executor = ContextCompat.getMainExecutor(activity);
          final boolean[] settled = {false};
          BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
              if (settled[0]) return; settled[0] = true;
              promise.resolve(true);
            }
            @Override
            public void onAuthenticationError(int code, @NonNull CharSequence err) {
              if (settled[0]) return; settled[0] = true;
              promise.reject("AUTH_ERR_" + code, err.toString());
            }
            @Override
            public void onAuthenticationFailed() { /* один неверный отпечаток — ждём следующей попытки */ }
          });
          BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
              .setTitle(title != null ? title : "Prizrak")
              .setSubtitle(subtitle != null ? subtitle : "")
              .setNegativeButtonText(cancel != null ? cancel : "Отмена")
              .setAllowedAuthenticators(AUTHENTICATORS)
              .setConfirmationRequired(false)
              .build();
          prompt.authenticate(info);
        } catch (Exception e) {
          promise.reject("ERR", e.getMessage());
        }
      }
    });
  }
}
