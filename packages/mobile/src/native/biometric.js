// Обёртка над нативным модулем биометрии (Android BiometricPrompt).
import {NativeModules} from 'react-native';

const Native = NativeModules.PrizrakBiometric || null;
export const BIOMETRIC_SUPPORTED = !!Native;

// { available:bool, noneEnrolled:bool, code:int }
export async function biometricAvailable() {
  if (!Native) return {available: false, noneEnrolled: false, code: -1};
  try {
    return await Native.isAvailable();
  } catch {
    return {available: false, noneEnrolled: false, code: -1};
  }
}

// Показать системный диалог. true при успехе; бросает при отмене/ошибке.
export async function biometricAuth(
  title = 'Prizrak',
  subtitle = 'Подтвердите личность',
  cancel = 'Ввести PIN',
) {
  if (!Native) throw new Error('Биометрия недоступна');
  return await Native.authenticate(title, subtitle, cancel);
}
