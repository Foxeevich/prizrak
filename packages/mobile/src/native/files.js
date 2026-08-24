// Сохранение файлов в системные «Загрузки» (нативный модуль PrizrakFiles).
import {NativeModules} from 'react-native';

const Native = NativeModules.PrizrakFiles || null;
export const FILES_SUPPORTED = !!Native;

// Сохранить (base64) в Downloads; вернёт путь/имя для показа пользователю.
export async function saveToDownloads(filename, mime, base64) {
  if (!Native) throw new Error('Сохранение недоступно');
  return await Native.saveToDownloads(filename || 'file', mime || 'application/octet-stream', base64);
}
