// client-tunnel-rn.js — клиентская цепочка relay→exit к одному назначению,
// на сокетах React Native (react-native-tcp-socket). Крипта та же, что в узлах
// (shadow/breath/estafeta) — переиспользуем оттестированный протокол.

import TcpSocket from 'react-native-tcp-socket';
import {clientHandshake, clientComplete} from './shadow.js';
import {attachBreath} from './wire.js';
import {packCtrl, readCtrl, OP} from './estafeta.js';

const enc = s => new TextEncoder().encode(s);
const dec = u => new TextDecoder().decode(u);

/** Открыть туннель к dest через relay→exit. Возвращает {write,onData,onClose,close}. */
export function openTunnel({order, dest, timeoutMs = 15000}) {
  const relay = order.relay, exit = order.exit;
  return new Promise((resolve, reject) => {
    let phase = 'hsA', sessA = null, sessC = null, innerState = null;
    let onData = () => {}, onClose = () => {}, onDrainCb = () => {};
    let settled = false;
    const cHS = clientHandshake(relay.pub);
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('таймаут реле')); try { sock.destroy(); } catch {} } }, timeoutMs);

    const handle = {
      // Возвращает false, если реле-буфер переполнен → SOCKS притормозит клиента (аплоад).
      write: bytes => { if (!sessC) return true; try { return wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(bytes)))); } catch { return true; } },
      onData: cb => { onData = cb; },
      onClose: cb => { onClose = cb; },
      onDrain: cb => { onDrainCb = cb; },
      // Управление потоком: приостановить/возобновить чтение из реле (скачивание).
      // Без этого при высокой скорости JS-поток захлёбывается и приложение виснет.
      pause: () => { try { sock.pause(); } catch {} },
      resume: () => { try { sock.resume(); } catch {} },
      close: () => { try { wire.send(sessA.seal(packCtrl(OP.CLOSE, {}))); } catch {} wire.close(); },
    };

    const sock = TcpSocket.createConnection({host: relay.host, port: relay.port}, () => {
      wire.send(cHS.message);   // рукопожатие A
    });

    const wire = attachBreath(sock, {
      onDrain: () => { try { onDrainCb(); } catch {} },
      onFrame: f => {
        if (phase === 'hsA') {
          try { sessA = clientComplete(cHS.state, f); } catch { return; }
          phase = 'link';
          const ci = clientHandshake(exit.pub); innerState = ci.state;
          wire.send(sessA.seal(packCtrl(OP.LINK, {exit: {host: exit.host, port: exit.port, pub: exit.pub}, hs: [...ci.message], order})));
          return;
        }
        let ctrl; try { ctrl = readCtrl(sessA.open(f)); } catch { return; }
        if (ctrl.op === OP.LINK_OK && phase === 'link') {
          try { sessC = clientComplete(innerState, Uint8Array.from(JSON.parse(dec(ctrl.body)).hs)); } catch { return; }
          phase = 'up';
          wire.send(sessA.seal(packCtrl(OP.DATA, sessC.seal(enc(JSON.stringify({host: dest.host, port: dest.port}))))));
          settled = true; clearTimeout(to); resolve(handle);
          return;
        }
        if (ctrl.op === OP.LINK_FAIL) { if (!settled) { settled = true; clearTimeout(to); reject(new Error('выход недоступен через реле')); } return; }
        if (ctrl.op === OP.DATA && sessC) { try { onData(sessC.open(ctrl.body)); } catch {} return; }
        if (ctrl.op === OP.CLOSE) onClose();
      },
      onClose: () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('реле закрыло соединение')); } onClose(); },
    });
    sock.on('error', e => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
  });
}
