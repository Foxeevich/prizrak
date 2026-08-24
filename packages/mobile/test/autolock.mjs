// Логика автозамка: пауза + подавление на системные экраны (галерея и т.п.).
// Повторяем ровно те же правила, что в App.jsx (обработчик AppState).
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m));};

let _skipLockUntil = 0, NOW = 1000000;
const now = () => NOW;
const markSystemScreen = () => { _skipLockUntil = now() + 5*60*1000; };
const consumeSkipLock = () => { const okk = now() < _skipLockUntil; _skipLockUntil = 0; return okk; };

function makeApp(graceSec, pinSet = true) {
  let bgSince = 0, locked = false;
  return {
    get locked() { return locked; },
    background() { bgSince = now(); },
    foreground() {
      if (consumeSkipLock()) { bgSince = 0; return; }
      const away = bgSince ? now() - bgSince : 0; bgSince = 0;
      if (!pinSet) return;
      if (away < graceSec * 1000) return;
      locked = true;
    },
    unlock() { locked = false; },
  };
}

// 1. Галерея: ушли и вернулись — замка нет (наш баг с аватаром)
let a = makeApp(60); markSystemScreen(); a.background(); NOW += 8000; a.foreground();
ok(!a.locked, 'выбор картинки из галереи НЕ включает замок');

// 2. Короткое переключение окна без системного экрана — тоже не блокируем (в пределах паузы)
a = makeApp(60); a.background(); NOW += 10000; a.foreground();
ok(!a.locked, 'короткая отлучка (10 с) при паузе 60 с — замка нет');

// 3. Долгая отлучка — замок
a = makeApp(60); a.background(); NOW += 90000; a.foreground();
ok(a.locked, 'отлучка 90 с при паузе 60 с — замок включился');

// 4. «Сразу»: любая отлучка блокирует
a = makeApp(0); a.background(); NOW += 1000; a.foreground();
ok(a.locked, 'режим «Сразу» — блокирует даже через секунду');

// 5. Флаг одноразовый: следующая отлучка уже блокирует
a = makeApp(60); markSystemScreen(); a.background(); NOW += 5000; a.foreground();
a.background(); NOW += 120000; a.foreground();
ok(a.locked, 'флаг системного экрана одноразовый — вторая отлучка блокирует');

// 6. Флаг протухает: экран погас, пока была открыта галерея
a = makeApp(60); markSystemScreen(); a.background(); NOW += 6*60*1000; a.foreground();
ok(a.locked, 'если в галерее провели >5 мин — PIN всё равно спросят');

// 7. PIN не задан — замка нет никогда
a = makeApp(60, false); a.background(); NOW += 600000; a.foreground();
ok(!a.locked, 'без PIN замок не включается');

console.log(`\nАвтозамок: ${pass} ок, ${fail} провалов`); process.exit(fail?1:0);
