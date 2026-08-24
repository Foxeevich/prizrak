import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const A=8987,B=8988,UA=`http://127.0.0.1:${A}`,UB=`http://127.0.0.1:${B}`;
process.env.PRIZRAK_RESOLVER=JSON.stringify({'a.org':UA,'b.org':UB});
const sA=await createServer({domain:'a.org',port:A,storePath:null,storagePaths:['/tmp/mA'],registrationEnabled:true});
const sB=await createServer({domain:'b.org',port:B,storePath:null,storagePaths:['/tmp/mB'],registrationEnabled:true});
const mk=async(n,d,u)=>{const c=await new PrizrakClient({name:n,userId:`${n}:${d}`,baseUrl:u}).init();await c.register(`${n}-pass-123`);await c.serverConfig();return c;};
const alice=await mk('alice','a.org',UA), bob=await mk('bob','b.org',UB);
const ok=(c,m)=>{ if(!c){console.error('❌',m);process.exit(1);} console.log('✅',m); };
const N=6*1024*1024; const bytes=new Uint8Array(N); for(let i=0;i<N;i++)bytes[i]=(i*5)&0xff;
const up=await alice.sendAttachment('bob:b.org',bytes,{filename:'big.bin',mime:'application/octet-stream'});
ok(!sB.storage.has(up.mediaId), 'файл ещё НЕ на сервере получателя (при отправке не переносим — нет зависания)');
// Bob обрабатывает конверт: НЕ шлёт квитанцию автоматически (это делает приложение после ensureMedia)
const ev=(await bob.receive()).find(m=>m.kind==='attachment');
ok(ev && ev.attachment.voice!==true, 'Bob получил конверт вложения');
// авто-квитанции быть НЕ должно (проверим, что у Alice ещё нет 'received')
await new Promise(r=>setTimeout(r,80));
let aev=await alice.receive();
const gotReceived = aev.some(e=>e.kind==='receipt'&&e.status==='received'&&(e.msgIds||[]).includes(up.msgId));
ok(!gotReceived, 'Файл НЕ подтверждён автоматически (галочка ждёт наличия файла)');
// Отправитель переносит файл (push), приложение получателя ждёт готовности, потом шлёт received.
await alice.federateMedia(up.mediaId,'b.org');
let present=false; for(let i=0;i<200;i++){ const h=await bob.mediaHead(ev.attachment).catch(()=>({})); if(h.present){present=true;break;} await new Promise(r=>setTimeout(r,50)); }
ok(present===true, 'после push файл на сервере получателя (mediaHead present)');
ok(sB.storage.has(up.mediaId), 'блоб реально лёг на сервер получателя');
await bob.sendReceipt('alice:a.org',[up.msgId],'received');
await new Promise(r=>setTimeout(r,80));
aev=await alice.receive();
ok(aev.some(e=>e.kind==='receipt'&&e.status==='received'&&(e.msgIds||[]).includes(up.msgId)), 'После получения файла — квитанция доставки дошла до отправителя');
console.log('🎉 gate ok');
sA.server.close();sB.server.close();
