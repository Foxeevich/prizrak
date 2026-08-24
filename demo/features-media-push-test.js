import { createServer } from '../packages/server/src/server.js';
import { PrizrakClient } from '../packages/client/src/client.js';
const A=8985,B=8986,UA=`http://127.0.0.1:${A}`,UB=`http://127.0.0.1:${B}`;
process.env.PRIZRAK_RESOLVER=JSON.stringify({'a.org':UA,'b.org':UB});
const sA=await createServer({domain:'a.org',port:A,storePath:null,storagePaths:['/tmp/mA'],registrationEnabled:true});
const sB=await createServer({domain:'b.org',port:B,storePath:null,storagePaths:['/tmp/mB'],registrationEnabled:true});
const mk=async(n,d,u)=>{const c=await new PrizrakClient({name:n,userId:`${n}:${d}`,baseUrl:u}).init();await c.register(`${n}-pass-123`);await c.serverConfig();return c;};
const alice=await mk('alice','a.org',UA), bob=await mk('bob','b.org',UB);
const ok=(c,m)=>{ if(!c){console.error('❌',m);process.exit(1);} console.log('✅',m); };
// PUSH: большой файл (>4МБ)
const N=6*1024*1024; const bytes=new Uint8Array(N); for(let i=0;i<N;i++)bytes[i]=(i*5)&0xff;
const up=await alice.sendAttachment('bob:b.org',bytes,{filename:'big.bin',mime:'application/octet-stream'});
ok(!sB.storage.has(up.mediaId), 'файл пока НЕ на сервере получателя (переносит получатель по требованию)');
const att=(await bob.receive()).find(m=>m.kind==='attachment')?.attachment;
const got=await bob.fetchAttachment(att);
ok(got&&got.length===N, 'получатель скачал файл (сервер подтянул блоб с origin)');
ok(sB.storage.has(up.mediaId), 'после скачивания файл закэширован на сервере получателя');
// Удаление у всех между серверами
const dm=await alice.send('bob:b.org','удали меня');
await new Promise(r=>setTimeout(r,80));
let bm=(await bob.receive()); ok(bm.some(m=>m.text==='удали меня'),'Сообщение дошло до B');
await alice.deleteMessage(dm.msgId, 'bob:b.org');
await new Promise(r=>setTimeout(r,120));
const evs=await bob.receive();
ok(evs.some(e=>e.kind==='delete'&&e.msgId===dm.msgId),'DELETE: тумбстон дошёл до B по федерации');
const stillThere=(await sB.store.historySince('bob:b.org',0)).some(e=>e.envelope?.msgId===dm.msgId);
ok(!stillThere,'DELETE: сообщение удалено и в хранилище сервера получателя');
console.log('🎉 push + федеративное удаление — ок');
sA.server.close();sB.server.close();
