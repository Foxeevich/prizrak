// storage.js — менеджер файлового хранилища медиа.
// Возможности, которые просил админ:
//   • НЕСКОЛЬКО путей хранения (можно ДОБАВЛЯТЬ — напр. подключили новый диск);
//   • общий ЛИМИТ размера (чтобы не забить ФС на 100%): при превышении
//     вытесняются самые старые блобы;
//   • ретеншн-очистка по возрасту;
//   • статистика использования.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, appendFileSync, createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';

export class StorageManager {
  constructor({ paths, maxBytes }) {
    this.paths = (paths && paths.length ? paths : ['./data/media']).slice();
    this.maxBytes = maxBytes || 5 * 1024 * 1024 * 1024; // по умолчанию 5 ГБ
    this.index = {}; // id → { path, bytes, at, mime, nonce }
    for (const p of this.paths) mkdirSync(p, { recursive: true });
    this._loadIndex();
  }
  _indexFile() { return join(this.paths[0], 'prizrak-media-index.json'); }
  _loadIndex() { try { if (existsSync(this._indexFile())) this.index = JSON.parse(readFileSync(this._indexFile(), 'utf8')); } catch {} }
  _saveIndex() { try { writeFileSync(this._indexFile(), JSON.stringify(this.index)); } catch {} }

  totalBytes() { return Object.values(this.index).reduce((s, e) => s + e.bytes, 0); }

  // Выбрать путь с наименьшим использованием (балансировка по дискам).
  _pickPath() {
    const usage = Object.fromEntries(this.paths.map((p) => [p, 0]));
    for (const e of Object.values(this.index)) if (usage[e.path] != null) usage[e.path] += e.bytes;
    return this.paths.reduce((best, p) => (usage[p] < usage[best] ? p : best), this.paths[0]);
  }

  addPath(dir) {
    if (!this.paths.includes(dir)) { mkdirSync(dir, { recursive: true }); this.paths.push(dir); }
    return this.paths.slice();
  }

  /** Сохранить блоб (ciphertext — hex). Возвращает id. Соблюдает лимит. */
  put(id, { ciphertext, nonce, mime }) {
    const buf = Buffer.from(ciphertext, 'hex');
    if (buf.length > this.maxBytes) throw new Error('Файл больше общего лимита хранилища');
    this._evictUntilFits(buf.length);
    const path = this._pickPath();
    const file = join(path, id + '.blob');
    writeFileSync(file, buf);
    this.index[id] = { path, bytes: buf.length, at: Date.now(), mime, nonce };
    this._saveIndex();
    return id;
  }
  get(id) {
    const e = this.index[id]; if (!e) return null;
    try { return { ciphertext: readFileSync(join(e.path, id + '.blob')).toString('hex'), nonce: e.nonce, mime: e.mime }; }
    catch { return null; }
  }
  /** Сохранить блоб из буфера (без hex — для больших файлов). */
  putRaw(id, buf, { nonce, mime }) {
    if (buf.length > this.maxBytes) throw new Error('Файл больше общего лимита хранилища');
    this._evictUntilFits(buf.length);
    const path = this._pickPath();
    writeFileSync(join(path, id + '.blob'), buf);
    this.index[id] = { path, bytes: buf.length, at: Date.now(), mime, nonce };
    this._saveIndex();
    return id;
  }
  getRaw(id) { const e = this.index[id]; if (!e) return null; try { return { buffer: readFileSync(join(e.path, id + '.blob')), nonce: e.nonce, mime: e.mime }; } catch { return null; } }
  has(id) { return !!this.index[id]; }
  metaOf(id) { const e = this.index[id]; return e ? { nonce: e.nonce || '', mime: e.mime || '', bytes: e.bytes } : null; }
  pathOf(id) { const e = this.index[id]; return e ? join(e.path, id + '.blob') : null; }
  // Поток чтения блоба (для передачи между серверами без буфера в памяти).
  readStream(id) { const p = this.pathOf(id); return p ? createReadStream(p) : null; }
  // Приём блоба потоком (сервер↔сервер): пишем прямо в файл, не держим 80МБ в памяти.
  async putStream(id, readable, { nonce = '', mime = '' } = {}) {
    const path = this._pickPath(); const file = join(path, id + '.blob');
    await new Promise((res, rej) => { const ws = createWriteStream(file); readable.on('error', rej); ws.on('error', rej); ws.on('finish', res); readable.pipe(ws); });
    const bytes = statSync(file).size;
    if (bytes > this.maxBytes) { try { rmSync(file); } catch {} throw new Error('Файл больше общего лимита хранилища'); }
    this.index[id] = { path, bytes, at: Date.now(), mime, nonce };
    this._evictUntilFits(0); this._saveIndex();
    return id;
  }

  // ── Чанковая (частичная) загрузка больших файлов ──────────────────────────
  _tmpDir() { const d = join(this.paths[0], 'tmp'); mkdirSync(d, { recursive: true }); return d; }
  _tmpFile(uploadId) { return join(this._tmpDir(), uploadId.replace(/[^a-f0-9]/gi, '') + '.part'); }
  appendChunk(uploadId, buf) { appendFileSync(this._tmpFile(uploadId), buf); }
  tmpSize(uploadId) { try { return statSync(this._tmpFile(uploadId)).size; } catch { return 0; } }
  finishUpload(id, uploadId, { nonce, mime }) {
    const f = this._tmpFile(uploadId);
    if (!existsSync(f)) throw new Error('Нет данных загрузки');
    const buf = readFileSync(f);
    try { this.putRaw(id, buf, { nonce, mime }); } finally { try { rmSync(f); } catch {} }
    return id;
  }
  abortUpload(uploadId) { try { rmSync(this._tmpFile(uploadId)); } catch {} }
  _remove(id) {
    const e = this.index[id]; if (!e) return;
    try { rmSync(join(e.path, id + '.blob')); } catch {}
    delete this.index[id];
  }
  /** Публичное удаление блоба по id (освобождает место сразу). Идемпотентно. */
  remove(id) { const had = !!this.index[id]; this._remove(id); if (had) this._saveIndex(); return had; }
  _evictUntilFits(incoming) {
    let total = this.totalBytes();
    if (total + incoming <= this.maxBytes) return;
    const byAge = Object.entries(this.index).sort((a, b) => a[1].at - b[1].at); // старые первыми
    for (const [id, e] of byAge) {
      if (total + incoming <= this.maxBytes) break;
      this._remove(id); total -= e.bytes;
    }
    this._saveIndex();
  }
  /** Удалить блобы старше retentionSeconds. */
  pruneOlderThan(retentionSeconds) {
    if (!isFinite(retentionSeconds)) return 0;
    const cutoff = Date.now() - retentionSeconds * 1000; let n = 0;
    for (const [id, e] of Object.entries(this.index)) if (e.at < cutoff) { this._remove(id); n++; }
    if (n) this._saveIndex();
    return n;
  }
  setMaxBytes(n) { this.maxBytes = n; this._evictUntilFits(0); }
  stats() {
    const perPath = Object.fromEntries(this.paths.map((p) => [p, 0]));
    for (const e of Object.values(this.index)) if (perPath[e.path] != null) perPath[e.path] += e.bytes;
    return { paths: this.paths, maxBytes: this.maxBytes, usedBytes: this.totalBytes(), count: Object.keys(this.index).length, perPath };
  }
}
