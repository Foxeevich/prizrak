// Профиль группы с мобилки: название, описание, аватар + настройки одной кнопкой.
import { createServer } from '../src/server.js';
import { PrizrakClient } from '../../client/src/client.js';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};
const dir=mkdtempSync(join(tmpdir(),'gp-')); const P=8969, D='g.invalid', BASE='http://127.0.0.1:'+P;
let hs;
try{
  hs=await createServer({domain:D,port:P,ports:[P],storePath:join(dir,'store.json'),resolver:{[D]:BASE}});
  const mk=async n=>{const c=await new PrizrakClient({name:n,userId:`${n}:${D}`,baseUrl:BASE,deviceId:n}).init();await c.register('password-123');await c.publishDevice();return c;};
  const fox=await mk('fox'), bob=await mk('bob');
  const g=await fox.createGroup('Старое имя'); const id=g.roomId||g.id;
  await fox.invite(id, bob.userId);

  await fox.setRoomProfile(id, {name:'Prizrak.im', description:'Наша группа', avatar:{mime:'image/png', data:'iVBORw0KGgo='}});
  const r=await fox.getRoom(id);
  ok(r.name==='Prizrak.im','название сохранилось');
  ok(r.description==='Наша группа','описание сохранилось');
  ok(r.avatar && r.avatar.data==='iVBORw0KGgo=','аватар сохранился');

  await fox.setRoomSettings(id,{privacy:'public'});
  ok((await fox.getRoom(id)).privacy==='public','тип группы: частная → публичная');

  const rb=await bob.getRoom(id);
  ok(rb.name==='Prizrak.im' && rb.avatar,'участник видит новое имя и аватар');

  let err=null; try{ await bob.setRoomProfile(id,{name:'Взлом'}); }catch(e){err=e.message;}
  ok(!!err,'рядовой участник профиль менять не может');
}catch(e){fail++;console.log('  ✗ исключение:',e.message);}
finally{try{hs?.closeAll?.();}catch{};try{rmSync(dir,{recursive:true,force:true});}catch{}}
console.log(`\nПрофиль группы: ${pass} ок, ${fail} провалов`); process.exit(fail?1:0);
