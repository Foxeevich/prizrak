// ticket.js — билеты доступа к VPN.
//
// Билет — это подписанное Ed25519 разрешение: «пользователю X можно ходить
// через сеть до такого-то времени, не больше N байт». Подписывает Банк
// Призраков (или владелец узла — своим ключом, для приватных узлов).
//
// Почему билеты, а не логин/пароль на узле:
//   • узел НЕ ходит в Банк на каждое подключение — проверил подпись и всё;
//   • узел не знает, кто вы: в билете только непрозрачный id и лимиты;
//   • отозвать можно коротким сроком жизни (сутки) — переподписать дёшево.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

// Канонические байты билета — то, что реально подписывается.
export function ticketBytes(t) {
  return utf8ToBytes(JSON.stringify({
    v: 1, sub: t.sub, exp: t.exp, bytes: t.bytes, tier: t.tier || 'basic', iss: t.iss || '',
  }));
}

/** Выписать билет (на стороне Банка/владельца узла). secretHex — Ed25519 seed. */
export function issueTicket(secretHex, { sub, ttlSec = 86400, bytes = 0, tier = 'basic', iss = '' } = {}) {
  const t = { v: 1, sub: String(sub), exp: Math.floor(Date.now() / 1000) + ttlSec, bytes: Number(bytes) || 0, tier, iss };
  const sig = ed25519.sign(ticketBytes(t), hexToBytes(secretHex));
  return { ...t, sig: bytesToHex(sig) };
}

/**
 * Проверить билет. Возвращает {ok:true, ticket} или {ok:false, error}.
 * trustedPubs — список доверенных издателей (hex Ed25519). Узел решает сам,
 * чьи билеты принимать: Банка, свои, или и те и другие.
 */
export function verifyTicket(ticket, trustedPubs = []) {
  if (!ticket || typeof ticket !== 'object') return { ok: false, error: 'нет билета' };
  if (!ticket.sig || !ticket.sub) return { ok: false, error: 'билет без подписи' };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ticket.exp) || ticket.exp < now) return { ok: false, error: 'билет просрочен' };
  const msg = ticketBytes(ticket);
  for (const pub of trustedPubs) {
    try { if (ed25519.verify(hexToBytes(ticket.sig), msg, hexToBytes(pub))) return { ok: true, ticket }; } catch {}
  }
  return { ok: false, error: 'подпись билета не принимается этим узлом' };
}

/** Короткий непрозрачный id сессии для учёта (не раскрывает, кто это). */
export const ticketId = (t) => bytesToHex(sha256(utf8ToBytes(String(t.sub) + '|' + String(t.exp)))).slice(0, 16);
