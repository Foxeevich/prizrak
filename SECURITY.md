# Security Policy / Политика безопасности

## 🇬🇧 Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Prizrak is a tool people rely on to communicate safely, so we handle security
reports privately. Report a vulnerability through GitHub's private advisory form:

**→ https://github.com/Foxeevich/prizrak/security/advisories/new**

(Repository owner: enable "Private vulnerability reporting" in
*Settings → Code security and analysis* to activate this form.)

Please include:

- affected component (desktop / mobile / server / deaddrop / vpn) and version,
- a description and, if possible, steps to reproduce,
- the potential impact.

We aim to acknowledge reports quickly and will coordinate a fix and disclosure
timeline with you. Please give us reasonable time to release a fix before any
public disclosure.

**In scope:** end-to-end encryption, transport/stealth layer, federation and
delivery, the hidden-node network, the auto-update signature check, key handling.

**Out of scope:** anything requiring a compromised device or a malicious
homeserver you already control; the payment backend (not in this repository).

---

## 🇷🇺 Сообщение об уязвимости

**Пожалуйста, не создавайте публичный issue по уязвимостям.**

Prizrak — инструмент, на который люди полагаются для безопасного общения,
поэтому сообщения об уязвимостях мы обрабатываем приватно. Сообщите об
уязвимости через приватную форму GitHub:

**→ https://github.com/Foxeevich/prizrak/security/advisories/new**

(Владельцу репозитория: включите «Private vulnerability reporting» в
*Settings → Code security and analysis*, чтобы форма заработала.)

Укажите, пожалуйста:

- затронутый компонент (desktop / mobile / server / deaddrop / vpn) и версию,
- описание и, по возможности, шаги воспроизведения,
- потенциальные последствия.

Мы постараемся быстро подтвердить получение и согласуем с вами сроки
исправления и раскрытия. Пожалуйста, дайте разумное время на выпуск
исправления до публичного раскрытия.

**В зоне ответственности:** сквозное шифрование, транспорт/стелс-слой,
федерация и доставка, сеть узлов-тайников, проверка подписи обновлений,
обращение с ключами.

**Вне зоны:** сценарии, требующие уже скомпрометированного устройства или
вредоносного сервера под вашим контролем; платёжный бэкенд (в репозиторий
не входит).
