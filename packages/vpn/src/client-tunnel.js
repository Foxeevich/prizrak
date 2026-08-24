// client-tunnel.js — клиентская сторона: поднять двухпрыжковую цепочку к одному
// назначению и качать через неё байты.
//
//   приложение ──► openTunnel(relay, exit, dest) ──► реле ──► выход ──► dest
//
// Одна цепочка = одно соединение к назначению (как CONNECT в прокси). SOCKS-слой
// (socks.js) поднимает по такой цепочке на каждое соединение приложения.
// Переиспользует всё тестированное: shadow (Тень), wire (Дыхание), estafeta.

import net from 'node:net';
import { clientHandshake, clientComplete } from './shadow.js';
import { attachBreath } from './wire.js';
import { packCtrl, readCtrl, OP } from './estafeta.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

/**
 * Открыть туннель к dest по ОРДЕРУ Банка (реле+выход берутся из ордера).
 * @param {object} order — подписанный Банком ордер {relay,exit,sub,exp,sig,...}
 * @param {object} dest  {host, port}
 * @returns Promise<{ write(bytes), onData(cb), onClose(cb), close() }>
 */
export function openTunnel({ order, dest, timeoutMs = 15000 }) {
  const relay = order.relay, exit = order.exit;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: relay.host, port: relay.port });
    let phase = 'hsA', sessA = null, sessC = null, innerState = null;
    let onData = () => {}, onClose = () => {};
    let settled = false;
    const cHS = clientHandshake(relay.pub);
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('таймаут реле')); sock.destroy(); } }, timeoutMs);

    const handle = {
      write: (bytes) => { if (sessC) try { wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(bytes)))); } catch {} },
      onData: (cb) => { onData = cb; },
      onClose: (cb) => { onClose = cb; },
      close: () => { try { wire.send(sessA.seal(packCtrl(OP.CLOSE, {}))); } catch {} wire.close(); },
    };

    const wire = attachBreath(sock, {
      onFrame: (f) => {
        if (phase === 'hsA') {
          try { sessA = clientComplete(cHS.state, f); } catch { return; }
          phase = 'link';
          const ci = clientHandshake(exit.pub); innerState = ci.state;
          wire.send(sessA.seal(packCtrl(OP.LINK, { exit: { host: exit.host, port: exit.port, pub: exit.pub }, hs: [...ci.message], order })));
          return;
        }
        let ctrl; try { ctrl = readCtrl(sessA.open(f)); } catch { return; }
        if (ctrl.op === OP.LINK_OK && phase === 'link') {
          try { sessC = clientComplete(innerState, Uint8Array.from(JSON.parse(dec(ctrl.body)).hs)); } catch { return; }
          phase = 'up';
          // Первый кадр C — CONNECT к назначению.
          wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(enc(JSON.stringify({ host: dest.host, port: dest.port }))))));
          settled = true; clearTimeout(to); resolve(handle);
          return;
        }
        if (ctrl.op === OP.LINK_FAIL) { if (!settled) { settled = true; clearTimeout(to); reject(new Error('выход недоступен через реле')); } return; }
        if (ctrl.op === OP.DATA && sessC) { try { onData(sessC.open(ctrl.body)); } catch {} return; }
        if (ctrl.op === OP.CLOSE) onClose();
      },
      onClose: () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('реле закрыло соединение')); } onClose(); },
    });
    sock.on('connect', () => wire.send(cHS.message));
    sock.on('error', (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
  });
}
