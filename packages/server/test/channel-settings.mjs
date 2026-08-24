import { createServer } from '../src/server.js';
import { PrizrakClient } from '../../client/src/client.js';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};
const dir=mkdtempSync(join(tmpdir(),'ch-')); const P=8967,D='c.invalid',BASE='http://127.0.0.1:'+P; let hs;
try{
  hs=await createServer({domain:D,port:P,ports:[P],storePath:join(dir,'store.json'),resolver:{[D]:BASE}});
  const fox=await new PrizrakClient({name:'fox',userId:'fox:'+D,baseUrl:BASE,deviceId:'d'}).init();
  await fox.register('password-123'); await fox.publishDevice();
  const ch=await fox.createChannel('Мой канал'); const id=ch.roomId||ch.id;
  ok((await fox.getRoom(id)).type==='channel','канал создан');
  await fox.setRoomSettings(id,{privacy:'public'});
  ok((await fox.getRoom(id)).privacy==='public','канал переключается в ПУБЛИЧНЫЙ');
  await fox.setRoomProfile(id,{name:'Prizrak.im',avatar:{mime:'image/png',data:'iVBORw0KGgo='}});
  const r=await fox.getRoom(id);
  ok(r.name==='Prizrak.im' && r.avatar,'у канала меняются имя и аватар');
  await fox.setRoomSettings(id,{privacy:'private'});
  ok((await fox.getRoom(id)).privacy==='private','канал возвращается в частный');
}catch(e){fail++;console.log('  ✗ исключение:',e.message);}
finally{try{hs?.closeAll?.();}catch{};try{rmSync(dir,{recursive:true,force:true});}catch{}}
console.log(`\nКанал: ${pass} ок, ${fail} провалов`); process.exit(fail?1:0);
