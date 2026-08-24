// Полифиллы для запуска криптоядра Prizrak в React Native (Hermes).
// ВАЖНО: импортируется САМЫМ ПЕРВЫМ (до openpgp/@noble/клиента).

// 1. crypto.getRandomValues — нужен @noble/* и openpgp для генерации ключей/нонсов.
import 'react-native-get-random-values';

// 2. TextEncoder/TextDecoder (utf-8) — используется по всему ядру.
import 'text-encoding-polyfill';

// 3. Buffer — некоторые ветки openpgp обращаются к global.Buffer.
import {Buffer} from 'buffer';
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// 4. Web Streams — openpgp опирается на ReadableStream/TransformStream.
import {
  ReadableStream,
  WritableStream,
  TransformStream,
} from 'web-streams-polyfill/ponyfill/es6';
if (typeof global.ReadableStream === 'undefined') {
  global.ReadableStream = ReadableStream;
}
if (typeof global.WritableStream === 'undefined') {
  global.WritableStream = WritableStream;
}
if (typeof global.TransformStream === 'undefined') {
  global.TransformStream = TransformStream;
}

// 5. btoa/atob — на случай, если Hermes не предоставил (openpgp armor).
if (typeof global.btoa === 'undefined') {
  global.btoa = data => Buffer.from(data, 'binary').toString('base64');
}
if (typeof global.atob === 'undefined') {
  global.atob = b64 => Buffer.from(b64, 'base64').toString('binary');
}

// 6. WebCrypto (crypto.subtle) — В Hermes его нет, а openpgp без него падает
//    («The WebCrypto API is not available» → вылет при входе). Ставим наш
//    полифилл на @noble. ВАЖНО: до первого импорта openpgp.
import {installWebCrypto} from './webcrypto-subtle';
installWebCrypto();
