# Contributing to Prizrak / Вклад в Prizrak

## 🇬🇧 English

Contributions are welcome — code, docs, translations, bug reports.

### Getting started

```bash
git clone https://github.com/Foxeevich/prizrak.git
cd prizrak
# run the test suite (crypto, features, mobile core):
npm install
npm test
```

Build & run individual components — see the **[README](README.md)** (server,
hidden node, desktop, mobile).

### Ground rules

- **Never commit secrets** — keys, tokens, passwords, certificates, keystores,
  `prizrak.config.json`, or user data. The `.gitignore` covers the known ones;
  double-check your diff.
- Keep changes focused; one topic per pull request.
- Match the existing code style; keep comments useful.
- Add or update tests in `demo/` (or the relevant package) when it makes sense.
- Update **[CHANGELOG.md](CHANGELOG.md)** for anything user-facing.
- Use the pull request template and tick the checklist.

### Licensing of contributions

By submitting a contribution you agree to license it under the project's
**AGPL-3.0** license (see [LICENSE](LICENSE)).

### Reporting bugs & vulnerabilities

- Regular bugs → open an issue with the bug template.
- Security vulnerabilities → **private** report, see **[SECURITY.md](SECURITY.md)**.

---

## 🇷🇺 Русский

Вклад приветствуется — код, документация, переводы, отчёты об ошибках.

### С чего начать

```bash
git clone https://github.com/Foxeevich/prizrak.git
cd prizrak
# запустить тесты (crypto, фичи, ядро мобилки):
npm install
npm test
```

Сборка и запуск отдельных компонентов — см. **[README](README.md)** (сервер,
узел-тайник, десктоп, мобилка).

### Основные правила

- **Никогда не коммитьте секреты** — ключи, токены, пароли, сертификаты,
  keystore, `prizrak.config.json`, данные пользователей. `.gitignore` покрывает
  известные; всё равно перепроверяйте свой diff.
- Держите изменения сфокусированными; один PR — одна тема.
- Следуйте существующему стилю кода; комментарии — по делу.
- Добавляйте/обновляйте тесты в `demo/` (или в нужном пакете), где уместно.
- Обновляйте **[CHANGELOG.md](CHANGELOG.md)** для всего, что заметно пользователю.
- Используйте шаблон pull request и отметьте чеклист.

### Лицензирование вклада

Отправляя вклад, вы соглашаетесь лицензировать его под лицензией проекта
**AGPL-3.0** (см. [LICENSE](LICENSE)).

### Отчёты об ошибках и уязвимостях

- Обычные баги → issue по шаблону.
- Уязвимости безопасности → **приватно**, см. **[SECURITY.md](SECURITY.md)**.
