// app.js — логика UI (рендерер) v1.2. Через window.prizrak (preload) общается с main.
const $ = (id) => document.getElementById(id);
const state = { linkPreviews: true, me: null, conversations: new Map(), activeId: null, balance: 0, selected: new Set(), search: '', theme: 'dark', tab: 'chats', notif: true, sound: true, emojiRecent: [], lang: null };

// Звук входящего сообщения (старый «Oh-oh!» из ICQ). Один переиспользуемый Audio.
let _incomingAudio = null;
function playIncomingSound() {
  if (state.sound === false) return;
  try {
    if (!_incomingAudio) { _incomingAudio = new Audio('assets/incoming.mp3'); _incomingAudio.volume = 0.9; }
    _incomingAudio.currentTime = 0;
    _incomingAudio.play().catch(() => {});
  } catch {}
}
const GHOST_SITE = 'https://prizrak.paymoney.online'; // покупка призраков — только здесь

// ── Локализация (i18n): английский основной, русский — второй ─────────────────
const I18N = {
  en: {
    'common.close': 'Close', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.done': 'Done',
    'common.back': '‹ Back', 'common.copy': 'Copy', 'common.loading': 'Loading…', 'common.ok': 'OK', 'common.yes': 'Yes', 'common.remove': 'Remove', 'common.confirm': 'Confirmation', 'common.on': 'On', 'common.off': 'Off', 'avatar.tooBig': 'Avatar too large (~512KB max)',
    'auth.subtitle': 'Decentralized messenger · no phone number', 'auth.homeserver': 'Home server', 'auth.username': 'Username',
    'auth.idFormat': 'Format <b>user:domain</b> (colon, like Matrix — no “@”).', 'auth.displayName': 'Display name', 'auth.password': 'Password',
    'auth.passwordPh': 'at least 8 characters', 'auth.invite': 'Invite code', 'auth.register': 'Sign up', 'auth.login': 'Log in',
    'auth.customServer': 'Custom server', 'auth.customPh': 'http://my.server:8801', 'auth.loginPh': 'alice',
    'auth.password2': 'Confirm password', 'auth.password2Ph': 'repeat password',
    'auth.checking': 'Checking…', 'auth.serverUp': 'Server online', 'auth.serverDown': 'Server unavailable',
    'auth.regOpen': 'registration open', 'auth.regClosed': 'registration closed',
    'auth.needLogin': 'Enter a login', 'auth.needServer': 'Server unavailable — pick another', 'auth.pwShort': 'Password must be at least 8 characters', 'auth.pwMismatch': 'Passwords do not match',
    'auth.restore': 'Restore account from a backup file',
    'set.recovery': 'Backup & recovery', 'set.backup': 'Back up account', 'set.backupHint': 'The backup file grants access to your account. Keep it safe and never share it.',
    'acct.exportTitle': 'Account backup', 'acct.exportHint': 'Set a password for the backup file — you will need it to restore.', 'acct.pw': 'File password', 'acct.pw2': 'Repeat password', 'acct.make': 'Save backup', 'acct.saved': 'Backup saved', 'acct.pwShort': 'Password too short (min 6)',
    'acct.restoreTitle': 'Restore account', 'acct.server': 'Server', 'acct.filePw': 'Backup file password', 'acct.accPw': 'Account password', 'acct.restoreBtn': 'Restore',
    'auth.restoreSeed': 'Restore using recovery phrase', 'set.seed': 'Recovery phrase',
    'seed.title': 'Recovery phrase', 'seed.hint': 'Write down these words in order and keep them safe. They restore your account without a password.', 'seed.warn': 'Anyone with this phrase can access your account. Never share it.', 'seed.copy': 'Copy', 'seed.copied': 'Phrase copied', 'seed.warnEnable': '',
    'seed.recoverTitle': 'Restore by recovery phrase', 'seed.phrase': 'Recovery phrase', 'seed.newPw': 'New password',
    'set.devices': 'Devices', 'dev.title': 'My devices', 'dev.current': 'this device', 'dev.added': 'added', 'dev.revoke': 'Revoke', 'dev.revoked': 'Device revoked', 'dev.none': 'No devices in the registry yet.',
    'wallet.tip': 'My ghosts — balance, buy, gifts', 'wallet.mine': 'My ghosts ›',
    'side.newChat': '＋ Chat', 'side.newGroup': '＋ Group', 'side.newChannel': '＋ Channel', 'side.searchChats': '🔍 Search chats…',
    'side.addContact': '＋ Add contact', 'side.searchContacts': '🔍 Search contacts…',
    'nav.contacts': 'Contacts', 'nav.calls': 'Calls', 'nav.chats': 'Chats', 'nav.settings': 'Settings',
    'chat.pick': 'Select a chat', 'chat.audioCall': 'Voice call', 'chat.videoCall': 'Video call', 'chat.gift': 'Gift 👻',
    'chat.retention': 'History retention', 'chat.share': 'Share', 'chat.roomSettings': 'Room settings', 'chat.peerProfile': 'Contact profile',
    'chat.members': 'Members and roles', 'chat.delSel': 'Delete selected', 'chat.invite': 'Invite',
    'composer.attach': 'Attach file', 'composer.emoji': 'Emoji', 'composer.voice': 'Record voice message', 'composer.message': 'Message…', 'composer.send': 'Send',
    'composer.lock': '🔒 Only admins can post in this channel', 'composer.recording': '🔴 Recording… {t}',
    'sel.delete': 'Delete', 'sel.forward': 'Forward', 'sel.selected': 'Selected {n}',
    'set.myProfile': 'My profile', 'set.myGhosts': 'My ghosts', 'set.appearance': 'Appearance', 'set.theme': 'Theme',
    'set.themeAuto': 'Auto', 'set.themeDark': 'Dark', 'set.themeLight': 'Light', 'set.language': 'Language',
    'set.notifSound': 'Notifications and sound', 'set.showNotif': 'Show notifications', 'set.msgSound': 'Incoming message sound', 'set.system': 'System',
    'set.autostart': 'Launch at system startup', 'set.closeTray': 'Minimize to tray on close', 'set.checkUpd': 'Check for updates', 'set.serverAdmin': 'Server settings (admin)', 'set.logout': 'Log out',
    'set.langNote': 'Changes the interface language. Message text is not translated.',
    'ghosts.balanceTitle': 'Ghost Balance', 'ghosts.yourBalance': 'Your ghost balance', 'ghosts.buy': 'Buy', 'ghosts.gift': '🎁 Gift',
    'ghosts.available': 'Available balance', 'ghosts.withdraw': 'Withdraw via PayMoney (soon)', 'ghosts.withdrawNote': 'Withdrawals via PayMoney.online will come later.',
    'ghosts.history': 'Transaction history', 'ghosts.brand': 'Prizrak Ghosts', 'ghosts.brandSub': 'Ghosts are used for premium, gifts and in-app purchases in Prizrak.',
    'ghosts.yourBalanceShort': 'Your balance', 'ghosts.buyGhosts': 'Buy ghosts', 'ghosts.giftFriend': '🎁 Gift ghosts to a friend',
    'ghosts.note': 'Purchases go through the secure site <b>prizrak.paymoney.online</b>. The balance is unified and your ghosts can’t be forged.',
    'op.fromTo': 'From / To', 'op.id': 'Transaction ID', 'op.date': 'Date',
    'call.title': 'Call', 'call.connecting': 'Connecting…', 'call.muteMic': '🎙 Mute mic', 'call.unmuteMic': '🎙 Unmute mic', 'call.hangup': '✖ Hang up',
    'call.incoming': '📞 Incoming call', 'call.accept': 'Accept', 'call.decline': 'Decline', 'call.connected': 'Connected', 'call.calling': 'Calling…',
    'profile.title': 'My profile', 'profile.avatar': 'Avatar…', 'profile.name': 'Name', 'profile.namePh': 'Display name', 'profile.bio': 'About', 'profile.bioPh': 'a few words about you',
    'profile.birthday': 'Birthday', 'profile.phone': 'Phone (optional)', 'profile.showPhone': 'Show phone to others', 'profile.channel': 'Personal channel (optional)', 'profile.shareAccount': '🔗 Share account',
    'room.settings': 'Room settings', 'room.name': 'Name', 'room.desc': 'Description', 'room.descPh': 'what this community is about',
    'room.reactions': 'Reactions', 'room.reactOn': 'Enable reactions', 'room.reactPaid': 'Paid reactions<small>subscribers donate ghosts to the post author</small>',
    'room.editTitle': 'Edit', 'room.inviteLinks': 'Invite links', 'room.deleteChannel': 'Delete channel', 'room.deleteGroup': 'Delete group',
    'react.pickHint': 'You can add emoji from any set to the reactions list.', 'react.addReactions': 'Add reactions',
    'react.maxTitle': 'REACTIONS PER POST', 'react.maxHint': 'Set the maximum number of different reactions per post, including for previously published messages.',
    'react.paidOn': 'Enable paid reactions', 'react.paidHint': 'Enable so subscribers can donate ghosts to the post author as a reaction.', 'react.saveChanges': 'Save changes',
    'room.deleteAsk': 'Delete “{name}”? This cannot be undone.', 'room.reactWord': '{n} reactions',
    'diag.title': 'Delivery diagnostics', 'diag.hint': 'Checks whom the server can deliver keys/messages to. Red = this member won’t receive messages until the cause is fixed.',
    'diag.fix': 'Re-grant keys', 'diag.ok': 'reachable', 'diag.nokey': 'no channel key yet', 'diag.haskey': 'has key', 'diag.fixed': 'Re-granted keys to reachable members', 'diag.fixFail': 'Could not re-grant: {e}',
    'diag.granted': 'Keys granted: {n}', 'diag.rotated': '(key reissued)', 'diag.noRights': 'No rights — only the owner/admin can grant keys', 'diag.nothing': 'No one to grant to (no reachable members)',
    'gset.manage': 'Manage group', 'gset.title': 'Manage group', 'gset.type': 'Group type',
    'gset.public': 'Public', 'gset.publicHint': 'Discoverable in search, anyone can join', 'gset.private': 'Private', 'gset.privateHint': 'Join only by invite or link',
    'gset.perms': 'Member permissions', 'gset.p.send': 'Send messages', 'gset.p.media': 'Send media', 'gset.p.add': 'Add members', 'gset.p.pin': 'Pin messages', 'gset.p.info': 'Change group info', 'gset.p.tag': 'Change own tag',
    'gset.slow': 'Slow mode', 'gset.slow.off': 'Off', 'gset.autodel': 'Auto-delete messages', 'gset.autodel.off': 'Off', 'gset.autodel.1d': 'After 1 day', 'gset.autodel.1w': 'After 1 week', 'gset.autodel.1mo': 'After 1 month', 'gset.autodel.note': 'The server deletes messages older than the chosen period.',
    'gset.history': 'History for new members', 'gset.history.show': 'Show history to new members', 'gset.saved': 'Group settings saved',
    'side.findGroups': '🔍', 'gsrch.title': 'Find public groups', 'gsrch.ph': 'e.g. fishing', 'gsrch.empty': 'Nothing found', 'gsrch.hint': 'Type at least 2 characters', 'gsrch.join': 'Join', 'gsrch.joined': 'Joined: {n}', 'gsrch.members': '{n} members', 'gsrch.fail': 'Search failed: {e}',
    'info.private': 'Private', 'info.public': 'Public', 'info.histShown': 'Shown', 'info.histHidden': 'Hidden', 'info.ad.off': 'Off', 'info.ad.1d': '1 day', 'info.ad.1w': '1 week', 'info.ad.1mo': '1 month', 'common.copied': 'Copied', 'audio.fail': 'Audio: {e}',
    'chat.search': 'Search in chat', 'chat.searchPh': 'Search in chat…',
    'gift.shop': 'Send a gift', 'gift.shelf': '🎁 Gifts', 'gift.mine': 'My gifts', 'gift.send': 'Send', 'gift.anon': 'Send anonymously', 'gift.msgPh': 'Add a message (optional)…',
    'gift.youSent': 'You sent: {n}', 'gift.gotFrom': 'Gift: {n}', 'gift.anonSent': 'Anonymous gift: {n}', 'gift.sent': 'Gift sent! 🎁', 'gift.balance': 'Your balance: {n} 👻',
    'gift.left': '{n} left', 'gift.soldOut': 'Sold out', 'gift.convert': 'Dust for {n} 👻', 'gift.converted': 'Converted: +{n} 👻', 'gift.hide': 'Hide', 'gift.show': 'Show', 'gift.empty': 'No gifts yet', 'gift.from': 'from {n}', 'gift.fromAnon': 'from anonymous',
    'set.linkPreviews': 'Link previews', 'set.linkPrevHint': 'The card is built by your app and sent inside the encrypted message — the recipient never visits the site.',
    'set.privacy': 'Privacy', 'priv.blocked': 'Blocked users', 'priv.groups': 'Groups and channels', 'priv.calls': 'Calls',
    'set.vpn': 'Prizrak VPN', 'vpn.mask': 'Disguise all traffic', 'vpn.node': 'Run a ghost node',
    'vpn.maskHint': 'Route all device traffic through Prizrak. Prizrak messages and calls go directly.',
    'vpn.nodeHint': 'Become a relay node and earn 👻.', 'vpn.country': 'Exit country',
    'vpn.loading': 'Loading countries…', 'vpn.none': 'No exits available yet. They will appear once nodes are online.',
    'vpn.unavail': 'Disguise will appear in a build with the native tunnel. Below is the interface and country picker.',
    'vpn.switchHint': 'Switching country on the fly: the new exit is raised first, then the old one is dropped — open connections will drop when the IP changes.',
    'vpn.sub': 'Subscription', 'vpn.pay': 'Pay for VPN', 'vpn.payHint': 'Pay with ghosts to use the VPN',
    'priv.all': 'Everybody', 'priv.contacts': 'My contacts', 'priv.nobody': 'Nobody', 'priv.add': 'Add', 'priv.unblock': 'Unblock', 'priv.remove': 'Remove',
    'priv.whoGroups': 'WHO CAN ADD ME TO GROUPS', 'priv.whoCalls': 'WHO CAN CALL ME', 'priv.alwaysAllow': 'ALWAYS ALLOW', 'priv.blockedCap': 'BLOCKED USERS',
    'priv.groupsHint': 'You can choose who is allowed to invite you to groups and channels.', 'priv.callsHint': 'You can choose who can call you on Prizrak.',
    'priv.hint': 'Blocked users cannot message or call you, or add you to groups. They will not know they are blocked.',
    'priv.allowHint': 'These users get access regardless of the setting above.',
    'priv.emptyBlocked': 'No blocked users yet.', 'priv.emptyAllow': 'No exceptions yet.',
    'priv.badId': 'Enter a full ID: name:domain', 'priv.already': 'Already in the list',
    'gift.tapOpen': 'Click to open', 'gift.sender': 'Sender', 'gift.to': 'To', 'gift.anonName': 'Anonymous', 'gift.you': 'You', 'gift.price': 'Price', 'gift.date': 'Date', 'gift.close': 'Close', 'gift.info': 'Gift',
    'gift.noPeers': 'No contacts yet. Message someone first to send a gift.', 'gift.pickHint': 'Enter the recipient (user:domain). Your chats:',
    'safety.key': 'Safety key', 'safety.hint': 'Compare this number (or QR) with your contact over another channel — to make sure no one is eavesdropping.',
    'safety.markVerified': 'Mark as verified', 'safety.unmark': 'Unmark', 'safety.shareContact': 'Share contact',
    'safety.verified': '✓ verified', 'safety.changed': '⚠ key changed!', 'safety.unverified': 'not verified',
    'members.title': 'Members and roles', 'info.title': 'Info', 'info.add': 'Add', 'info.notif': 'Notifications', 'info.muteOn': 'Unmute', 'info.members': 'Members',
    'info.info': 'info', 'info.link': 'link', 'info.join': 'Join', 'info.leave': 'Leave', 'info.leaveCh': 'Leave channel', 'info.leaveGr': 'Leave group',
    'del.title': 'Delete message?', 'del.forEveryone': 'Delete for everyone (also for the other side)', 'del.delete': 'Delete',
    'roles.owner': 'owner', 'roles.admin': 'admin', 'roles.moderator': 'moderator', 'roles.member': 'member',
    'mm.admin': 'Make admin', 'mm.moderator': 'Make moderator', 'mm.demote': 'Remove role', 'mm.kick': 'Remove from {kind}', 'mm.ban': 'Block', 'mm.unban': 'Unblock', 'mm.transfer': 'Transfer ownership',
    'mm.transferAsk': 'Transfer ownership to {u}? This cannot be undone.', 'mm.kickAsk': 'Remove {u}?', 'mm.banAsk': 'Block {u}? They won’t be able to return.',
    'members.readonly': 'Read-only mode', 'members.roOn': 'Enable', 'members.roOff': 'Disable', 'members.banned': 'blocked', 'members.count.one': '{n} member', 'members.count.many': '{n} members',
    'members.subs.one': '{n} subscriber', 'members.subs.many': '{n} subscribers', 'kind.channel': 'channel', 'kind.group': 'group',
    'menu.reply': 'Reply', 'menu.copy': 'Copy text', 'menu.forward': 'Forward', 'menu.select': 'Select', 'menu.delete': 'Delete', 'menu.remove': 'Remove',
    'menu.pin': 'Pin', 'menu.unpin': 'Unpin', 'menu.mute': 'Mute', 'menu.unmute': 'Unmute', 'menu.archive': 'Archive', 'menu.unarchive': 'Unarchive', 'menu.deleteChat': 'Delete chat',
    'mute.title': 'Mute notifications for…', 'mute.hour': '1 hour', 'mute.day': '1 day', 'mute.week': 'a week', 'mute.forever': 'forever', 'mute.on': 'Unmute',
    'muteopt.1h': '1 hour', 'muteopt.3h': '3 hours', 'muteopt.12h': '12 hours', 'muteopt.1d': '1 day', 'muteopt.3d': '3 days', 'muteopt.7d': '7 days', 'muteopt.1mo': '1 month', 'muteopt.forever': 'Forever',
    'presence.online': 'online', 'presence.recently': 'seen recently', 'presence.lastSeen': 'last seen {ago} ago', 'presence.offline': 'offline',
    'presence.subs': '{n} subscribers', 'presence.membersN': '{n} members', 'presence.onlineN': '{n} online',
    'unit.year': 'y', 'unit.month': 'mo', 'unit.week': 'w', 'unit.day': 'd', 'unit.hour': 'h', 'unit.min': 'm', 'ago.less': 'less than a minute',
    'word.channel': 'channel', 'word.group': 'group', 'and': 'and',
    'reaction.failed': 'Could not react: {e}', 'paid.title': '👻 Donate to the post author', 'paid.hint': 'Send ghosts to the author — a paid reaction. Your balance: {n} 👻',
    'paid.custom': 'Custom…', 'paid.customTitle': 'Donate ghosts', 'paid.customHint': 'How many 👻 to send the author?', 'paid.sent': 'Sent {n} 👻 to the author', 'paid.failed': 'Could not donate: {e}',
    'paid.dmTitle': '👻 Donate ghosts', 'paid.dmHint': 'Send ghosts to {who} as a paid reaction. Your balance: {n} 👻',
    'react.more': 'More emoji', 'react.add': 'Add reaction',
    'emoji.recent': 'Recent', 'emoji.search': '🔍 Search emoji', 'emoji.empty': 'Nothing found',
    'emoji.cat.people': 'Smileys & People', 'emoji.cat.nature': 'Animals & Nature', 'emoji.cat.food': 'Food & Drink', 'emoji.cat.activity': 'Activities',
    'emoji.cat.travel': 'Travel & Places', 'emoji.cat.objects': 'Objects', 'emoji.cat.symbols': 'Symbols', 'emoji.cat.flags': 'Flags',
    'toast.linkCopied': 'Link copied', 'toast.sendErr': 'Send error: {e}', 'toast.copied': 'Copied',
    'share.hint': 'Invite link copied — forward it. Clicking it opens Prizrak and offers to join (or paste it into “＋ Chat”). {link}',
    'decode.one': '⚠️ Couldn’t decrypt a message (session updating…)', 'decode.many': '⚠️ {n} old messages couldn’t be decrypted (session updating…)',
    'newchat.title': 'New chat or link', 'newchat.hint': 'user:domain or prizrak://join/…', 'newgroup.title': 'New group', 'newgroup.hint': 'Name', 'newgroup.ph': 'Friends',
    'newchannel.title': 'New channel', 'newchannel.ph': 'Announcements', 'forward.title': 'Forward', 'forward.hint': 'Forward {n} {msg} — to whom? user:domain',
    'msg.messageN.one': 'message', 'msg.messageN.few': 'messages', 'msg.messageN.many': 'messages',
    'lang.ru': 'Russian', 'lang.en': 'English',
    'preview.voice': '🎤 Voice', 'preview.photo': '🖼 Photo', 'preview.file': '📎 File', 'preview.you': 'You: ',
    'cm.notifOn': 'Turn on notifications', 'cm.notifOff': 'Mute notifications', 'cm.separateWindow': 'Open in separate window', 'cm.copySel': 'Copy selection',
    'mute.h1': '1 hour', 'mute.h8': '8 hours', 'mute.d3': '3 days', 'mute.foreverItem': 'Forever',
    'menu.download': 'Download', 'menu.saveToPc': 'Save to computer', 'menu.unselect': 'Deselect',
    'op.purchase': 'Buy ghosts', 'op.giftIn': 'Gift received', 'op.giftOut': 'Gift sent', 'op.adminAdjust': 'Adjusted by admin', 'op.adminZero': 'Zeroed by admin', 'op.welcome': 'Welcome bonus', 'op.generic': 'Transaction',
    'who.payment': 'Payment', 'who.from': 'From', 'who.to': 'To', 'who.reason': 'Reason', 'who.details': 'Details',
    'status.serverDown': 'Server unavailable', 'status.keyUnavail': 'key unavailable: ', 'status.error': 'Error: ',
    'set.checking': 'Checking…',
    'fwd.title': 'Forward message', 'fwd.hint': 'Forward to whom? user:domain', 'members.loadFail': 'Could not load members',
    'contacts.add': 'Add contact', 'contacts.emptyHint': 'No contacts yet. Tap “＋ Add contact”.', 'calls.emptyHint': 'Call history will appear here. Start a call from a chat with 📞 or 🎥.',
    'call.micMuted': '🔇 Mic muted', 'mic.noAccess': 'No microphone access: {e}',
    'checkupd.checking': 'Checking…', 'checkupd.fail': 'Check failed: {e}', 'checkupd.avail': 'Version <b>{v}</b> available (you have {cur}). ', 'checkupd.dl': 'Download', 'checkupd.latest': 'You have the latest version ({cur}).',
    'checkupd.ready': 'Update {v} downloaded — click the green “Update Prizrak” bar.', 'checkupd.downloading': 'Downloading update… {p}%',
    'upd.button': 'Update Prizrak', 'upd.downloading': 'Downloading update… {p}%', 'upd.installing': 'Installing…', 'upd.readyTitle': 'Version {v} ready to install',
  },
  ru: {
    'common.close': 'Закрыть', 'common.cancel': 'Отмена', 'common.save': 'Сохранить', 'common.done': 'Готово',
    'common.back': '‹ Назад', 'common.copy': 'Скопировать', 'common.loading': 'Загрузка…', 'common.ok': 'OK', 'common.yes': 'Да', 'common.remove': 'Убрать', 'common.confirm': 'Подтверждение', 'common.on': 'Вкл.', 'common.off': 'Выкл.', 'avatar.tooBig': 'Аватар слишком большой (~512КБ макс)',
    'auth.subtitle': 'Децентрализованный мессенджер · без телефона', 'auth.homeserver': 'Домашний сервер', 'auth.username': 'Имя пользователя',
    'auth.idFormat': 'Формат <b>user:domain</b> (двоеточие, как в Matrix — без «@»).', 'auth.displayName': 'Отображаемое имя', 'auth.password': 'Пароль',
    'auth.passwordPh': 'минимум 8 символов', 'auth.invite': 'Инвайт-код', 'auth.register': 'Зарегистрироваться', 'auth.login': 'Войти',
    'auth.customServer': 'Свой сервер', 'auth.customPh': 'http://мой.сервер:8801', 'auth.loginPh': 'alice',
    'auth.password2': 'Подтверждение пароля', 'auth.password2Ph': 'повторите пароль',
    'auth.checking': 'Проверка…', 'auth.serverUp': 'Сервер работает', 'auth.serverDown': 'Сервер недоступен',
    'auth.regOpen': 'регистрация открыта', 'auth.regClosed': 'регистрация закрыта',
    'auth.needLogin': 'Введите логин', 'auth.needServer': 'Сервер недоступен — выберите другой', 'auth.pwShort': 'Пароль минимум 8 символов', 'auth.pwMismatch': 'Пароли не совпадают',
    'auth.restore': 'Восстановить аккаунт из файла копии',
    'set.recovery': 'Резервная копия и восстановление', 'set.backup': 'Сделать копию аккаунта', 'set.backupHint': 'Файл-копия = доступ к аккаунту. Храните в надёжном месте, не делитесь.',
    'acct.exportTitle': 'Копия аккаунта', 'acct.exportHint': 'Задайте пароль для файла копии — он понадобится при восстановлении.', 'acct.pw': 'Пароль файла', 'acct.pw2': 'Повторите пароль', 'acct.make': 'Сохранить копию', 'acct.saved': 'Копия сохранена', 'acct.pwShort': 'Слишком короткий пароль (мин. 6)',
    'acct.restoreTitle': 'Восстановление аккаунта', 'acct.server': 'Сервер', 'acct.filePw': 'Пароль файла копии', 'acct.accPw': 'Пароль аккаунта', 'acct.restoreBtn': 'Восстановить',
    'auth.restoreSeed': 'Восстановить по фразе восстановления', 'set.seed': 'Фраза восстановления',
    'seed.title': 'Фраза восстановления', 'seed.hint': 'Запишите эти слова по порядку и храните в надёжном месте. По ним аккаунт восстанавливается без пароля.', 'seed.warn': 'Любой, у кого есть эта фраза, получит доступ к аккаунту. Никому не показывайте.', 'seed.copy': 'Копировать', 'seed.copied': 'Фраза скопирована', 'seed.warnEnable': '',
    'seed.recoverTitle': 'Восстановление по фразе', 'seed.phrase': 'Фраза восстановления', 'seed.newPw': 'Новый пароль',
    'set.devices': 'Устройства', 'dev.title': 'Мои устройства', 'dev.current': 'это устройство', 'dev.added': 'добавлено', 'dev.revoke': 'Отозвать', 'dev.revoked': 'Устройство отозвано', 'dev.none': 'В реестре пока нет устройств.',
    'wallet.tip': 'Мои призраки — баланс, покупка, подарки', 'wallet.mine': 'Мои призраки ›',
    'side.newChat': '＋ Чат', 'side.newGroup': '＋ Группа', 'side.newChannel': '＋ Канал', 'side.searchChats': '🔍 Поиск чатов…',
    'side.addContact': '＋ Добавить контакт', 'side.searchContacts': '🔍 Поиск контактов…',
    'nav.contacts': 'Контакты', 'nav.calls': 'Звонки', 'nav.chats': 'Чаты', 'nav.settings': 'Настройки',
    'chat.pick': 'Выберите чат', 'chat.audioCall': 'Аудиозвонок', 'chat.videoCall': 'Видеозвонок', 'chat.gift': 'Подарить 👻',
    'chat.retention': 'Срок хранения истории', 'chat.share': 'Поделиться', 'chat.roomSettings': 'Настройки комнаты', 'chat.peerProfile': 'Профиль собеседника',
    'chat.members': 'Участники и роли', 'chat.delSel': 'Удалить выбранные', 'chat.invite': 'Пригласить',
    'composer.attach': 'Прикрепить файл', 'composer.emoji': 'Эмодзи', 'composer.voice': 'Записать голосовое', 'composer.message': 'Сообщение…', 'composer.send': 'Отправить',
    'composer.lock': '🔒 В этом канале пишут только администраторы', 'composer.recording': '🔴 Запись… {t}',
    'sel.delete': 'Удалить', 'sel.forward': 'Переслать', 'sel.selected': 'Выбрано {n}',
    'set.myProfile': 'Мой профиль', 'set.myGhosts': 'Мои призраки', 'set.appearance': 'Оформление', 'set.theme': 'Тема',
    'set.themeAuto': 'Авто', 'set.themeDark': 'Тёмная', 'set.themeLight': 'Светлая', 'set.language': 'Язык',
    'set.notifSound': 'Уведомления и звук', 'set.showNotif': 'Показывать уведомления', 'set.msgSound': 'Звук входящего сообщения', 'set.system': 'Система',
    'set.autostart': 'Запускать при входе в систему', 'set.closeTray': 'Сворачивать в трей при закрытии', 'set.checkUpd': 'Проверить обновления', 'set.serverAdmin': 'Настройки сервера (админ)', 'set.logout': 'Выйти из аккаунта',
    'set.langNote': 'Меняется язык интерфейса. Тексты сообщений не переводятся.',
    'set.vpn': 'Призрак-VPN', 'vpn.mask': 'Замаскироваться', 'vpn.node': 'Поднять призрак-узел',
    'vpn.maskHint': 'Весь трафик компьютера через Призрак. Сообщения и звонки Призрака — напрямую.',
    'vpn.nodeHint': 'Стать промежуточным узлом сети и зарабатывать 👻.', 'vpn.country': 'Страна выхода',
    'vpn.loading': 'Загружаю страны…', 'vpn.none': 'Пока нет доступных выходов. Появятся, как только заработают узлы.',
    'vpn.unavail': 'Маскировка появится в сборке с нативным туннелем. Ниже — интерфейс и выбор страны.',
    'vpn.switchHint': 'Смена страны на лету: сначала поднимается новый выход, потом рвётся старый — уже открытые соединения при смене IP оборвутся.',
    'vpn.sub': 'Подписка', 'vpn.pay': 'Оплатить VPN', 'vpn.payHint': 'Оплатите призраками, чтобы пользоваться VPN',
    'ghosts.balanceTitle': 'Баланс Призраков', 'ghosts.yourBalance': 'Ваш баланс призраков', 'ghosts.buy': 'Купить', 'ghosts.gift': '🎁 Подарить',
    'ghosts.available': 'Доступный баланс', 'ghosts.withdraw': 'Вывести через PayMoney (скоро)', 'ghosts.withdrawNote': 'Вывод средств через PayMoney.online появится позже.',
    'ghosts.history': 'История операций', 'ghosts.brand': 'Призраки Prizrak', 'ghosts.brandSub': 'Призраки нужны для премиума, подарков и покупок внутри Prizrak.',
    'ghosts.yourBalanceShort': 'Ваш баланс', 'ghosts.buyGhosts': 'Купить призраков', 'ghosts.giftFriend': '🎁 Подарить призраков другу',
    'ghosts.note': 'Покупка проходит на защищённом сайте <b>prizrak.paymoney.online</b>. Баланс — единый, ваши призраки нельзя подделать.',
    'op.fromTo': 'От / Кому', 'op.id': 'ID операции', 'op.date': 'Дата',
    'call.title': 'Звонок', 'call.connecting': 'Соединение…', 'call.muteMic': '🎙 Выкл. микрофон', 'call.unmuteMic': '🎙 Вкл. микрофон', 'call.hangup': '✖ Завершить',
    'call.incoming': '📞 Входящий звонок', 'call.accept': 'Принять', 'call.decline': 'Отклонить', 'call.connected': 'На связи', 'call.calling': 'Вызов…',
    'profile.title': 'Мой профиль', 'profile.avatar': 'Аватар…', 'profile.name': 'Имя', 'profile.namePh': 'Отображаемое имя', 'profile.bio': 'О себе', 'profile.bioPh': 'пару слов о себе',
    'profile.birthday': 'День рождения', 'profile.phone': 'Телефон (опционально)', 'profile.showPhone': 'Показывать телефон другим', 'profile.channel': 'Личный канал (опционально)', 'profile.shareAccount': '🔗 Поделиться аккаунтом',
    'room.settings': 'Настройки комнаты', 'room.name': 'Название', 'room.desc': 'Описание', 'room.descPh': 'о чём это сообщество',
    'room.reactions': 'Реакции', 'room.reactOn': 'Включить реакции', 'room.reactPaid': 'Платные реакции<small>подписчики донатят призраков автору поста</small>',
    'room.editTitle': 'Изменить', 'room.inviteLinks': 'Пригласительные ссылки', 'room.deleteChannel': 'Удалить канал', 'room.deleteGroup': 'Удалить группу',
    'react.pickHint': 'Вы можете добавить в список реакций эмодзи из любого набора.', 'react.addReactions': 'Добавить реакции',
    'react.maxTitle': 'КОЛИЧЕСТВО РЕАКЦИЙ НА ПУБЛИКАЦИЮ', 'react.maxHint': 'Задайте максимальное количество разных реакций на публикацию, в том числе для ранее опубликованных сообщений.',
    'react.paidOn': 'Включить платные реакции', 'react.paidHint': 'Включите, чтобы подписчики могли донатить призраков автору поста в качестве реакции.', 'react.saveChanges': 'Сохранить изменения',
    'room.deleteAsk': 'Удалить «{name}»? Это действие необратимо.', 'room.reactWord': '{n} реакций',
    'diag.title': 'Диагностика доставки', 'diag.hint': 'Проверяем, до кого сервер может доставить ключи/сообщения. Красное — участник не получит сообщения, пока не решится причина.',
    'diag.fix': 'Раздать ключи заново', 'diag.ok': 'доступен', 'diag.nokey': 'ещё нет ключа канала', 'diag.haskey': 'ключ есть', 'diag.fixed': 'Ключи розданы доступным участникам', 'diag.fixFail': 'Не удалось раздать: {e}',
    'diag.granted': 'Роздано ключей: {n}', 'diag.rotated': '(ключ перевыпущен)', 'diag.noRights': 'Нет прав — раздавать ключи может только владелец/админ', 'diag.nothing': 'Некому раздавать (нет доступных участников)',
    'gset.manage': 'Управление группой', 'gset.title': 'Управление группой', 'gset.type': 'Тип группы',
    'gset.public': 'Публичная', 'gset.publicHint': 'Доступна в поиске, вступить может любой', 'gset.private': 'Частная', 'gset.privateHint': 'Вступить только по приглашению или ссылке',
    'gset.perms': 'Разрешения участников', 'gset.p.send': 'Отправка сообщений', 'gset.p.media': 'Отправка медиафайлов', 'gset.p.add': 'Добавление участников', 'gset.p.pin': 'Закрепление сообщений', 'gset.p.info': 'Изменение профиля группы', 'gset.p.tag': 'Изменение своего тега',
    'gset.slow': 'Медленный режим', 'gset.slow.off': 'Выкл', 'gset.autodel': 'Автоудаление сообщений', 'gset.autodel.off': 'Выкл', 'gset.autodel.1d': 'Через 1 день', 'gset.autodel.1w': 'Через 1 неделю', 'gset.autodel.1mo': 'Через 1 месяц', 'gset.autodel.note': 'Сервер удаляет сообщения старше выбранного срока.',
    'gset.history': 'История для новых участников', 'gset.history.show': 'Показывать историю новым', 'gset.saved': 'Настройки группы сохранены',
    'side.findGroups': '🔍', 'gsrch.title': 'Поиск публичных групп', 'gsrch.ph': 'Например: рыбалка', 'gsrch.empty': 'Ничего не найдено', 'gsrch.hint': 'Введите минимум 2 символа', 'gsrch.join': 'Вступить', 'gsrch.joined': 'Вы вступили: {n}', 'gsrch.members': 'участников: {n}', 'gsrch.fail': 'Поиск не удался: {e}',
    'info.private': 'Частная', 'info.public': 'Публичная', 'info.histShown': 'Показана', 'info.histHidden': 'Скрыта', 'info.ad.off': 'Выкл', 'info.ad.1d': '1 день', 'info.ad.1w': '1 неделя', 'info.ad.1mo': '1 месяц', 'common.copied': 'Скопировано', 'audio.fail': 'Аудио: {e}',
    'chat.search': 'Поиск по чату', 'chat.searchPh': 'Поиск по чату…',
    'gift.shop': 'Отправить подарок', 'gift.shelf': '🎁 Подарки', 'gift.mine': 'Мои подарки', 'gift.send': 'Отправить', 'gift.anon': 'Отправить анонимно', 'gift.msgPh': 'Добавить сообщение (по желанию)…',
    'gift.youSent': 'Вы подарили: {n}', 'gift.gotFrom': 'Подарок: {n}', 'gift.anonSent': 'Анонимный подарок: {n}', 'gift.sent': 'Подарок отправлен! 🎁', 'gift.balance': 'Ваш баланс: {n} 👻',
    'gift.left': 'осталось {n}', 'gift.soldOut': 'Распродан', 'gift.convert': 'Распылить за {n} 👻', 'gift.converted': 'Распылён: +{n} 👻', 'gift.hide': 'Скрыть', 'gift.show': 'Показать', 'gift.empty': 'Подарков пока нет', 'gift.from': 'от {n}', 'gift.fromAnon': 'от анонима',
    'set.linkPreviews': 'Превью ссылок', 'set.linkPrevHint': 'Карточку собирает ваше приложение и шлёт внутри шифра — получатель на сайт не ходит.',
    'set.privacy': 'Конфиденциальность', 'priv.blocked': 'Чёрный список', 'priv.groups': 'Группы и каналы', 'priv.calls': 'Звонки',
    'priv.all': 'Все', 'priv.contacts': 'Мои контакты', 'priv.nobody': 'Никто', 'priv.add': 'Добавить', 'priv.unblock': 'Разблокировать', 'priv.remove': 'Убрать',
    'priv.whoGroups': 'КТО МОЖЕТ ДОБАВЛЯТЬ МЕНЯ В ГРУППЫ', 'priv.whoCalls': 'КТО МОЖЕТ МНЕ ЗВОНИТЬ', 'priv.alwaysAllow': 'ВСЕГДА РАЗРЕШАТЬ', 'priv.blockedCap': 'ЗАБЛОКИРОВАННЫЕ',
    'priv.groupsHint': 'Вы можете выбрать, кому разрешаете приглашать Вас в группы и каналы.', 'priv.callsHint': 'Вы можете выбрать, кто может звонить Вам в Призраке.',
    'priv.hint': 'Заблокированные не могут писать вам, звонить и добавлять вас в группы. Они не узнают, что заблокированы.',
    'priv.allowHint': 'Эти пользователи получают доступ независимо от настройки выше.',
    'priv.emptyBlocked': 'Список пуст. Добавьте тех, от кого не хотите получать сообщения и звонки.', 'priv.emptyAllow': 'Список исключений пуст.',
    'priv.badId': 'Введите полный ID: ник:домен', 'priv.already': 'Уже в списке',
    'gift.tapOpen': 'Нажмите, чтобы открыть', 'gift.sender': 'Отправитель', 'gift.to': 'Кому', 'gift.anonName': 'Аноним', 'gift.you': 'Вы', 'gift.price': 'Стоимость', 'gift.date': 'Дата', 'gift.close': 'Закрыть', 'gift.info': 'Подарок',
    'gift.noPeers': 'Пока нет собеседников. Напишите кому-нибудь, чтобы подарить.', 'gift.pickHint': 'Укажите получателя (user:domain). Ваши чаты:',
    'safety.key': 'Ключ безопасности', 'safety.hint': 'Сверьте это число (или QR) с собеседником по другому каналу — чтобы убедиться, что вас никто не подслушивает.',
    'safety.markVerified': 'Отметить проверенным', 'safety.unmark': 'Снять отметку', 'safety.shareContact': 'Поделиться контактом',
    'safety.verified': '✓ проверен', 'safety.changed': '⚠ ключ изменился!', 'safety.unverified': 'не проверен',
    'members.title': 'Участники и роли', 'info.title': 'Информация', 'info.add': 'Добавить', 'info.notif': 'Уведомления', 'info.muteOn': 'Вкл. звук', 'info.members': 'Участники',
    'info.info': 'информация', 'info.link': 'ссылка', 'info.join': 'Вступить', 'info.leave': 'Выйти', 'info.leaveCh': 'Выйти из канала', 'info.leaveGr': 'Выйти из группы',
    'del.title': 'Удалить сообщение?', 'del.forEveryone': 'Удалить у всех (у собеседника тоже)', 'del.delete': 'Удалить',
    'roles.owner': 'владелец', 'roles.admin': 'админ', 'roles.moderator': 'модератор', 'roles.member': 'участник',
    'mm.admin': 'Назначить админом', 'mm.moderator': 'Назначить модератором', 'mm.demote': 'Снять роль', 'mm.kick': 'Исключить из {kind}', 'mm.ban': 'Заблокировать', 'mm.unban': 'Разблокировать', 'mm.transfer': 'Передать владельца',
    'mm.transferAsk': 'Передать владельца → {u}? Действие необратимо.', 'mm.kickAsk': 'Исключить {u}?', 'mm.banAsk': 'Заблокировать {u}? Он не сможет вернуться.',
    'members.readonly': 'Режим «только чтение»', 'members.roOn': 'Включить', 'members.roOff': 'Выключить', 'members.banned': 'заблокирован', 'members.count.one': '{n} участник', 'members.count.many': '{n} участников',
    'members.subs.one': '{n} подписчик', 'members.subs.many': '{n} подписчиков', 'kind.channel': 'канала', 'kind.group': 'группы',
    'menu.reply': 'Ответить', 'menu.copy': 'Копировать текст', 'menu.forward': 'Переслать', 'menu.select': 'Выделить', 'menu.delete': 'Удалить', 'menu.remove': 'Убрать',
    'menu.pin': 'Закрепить', 'menu.unpin': 'Открепить', 'menu.mute': 'Без звука', 'menu.unmute': 'Включить звук', 'menu.archive': 'Архивировать', 'menu.unarchive': 'Разархивировать', 'menu.deleteChat': 'Удалить чат',
    'mute.title': 'Отключить уведомления на…', 'mute.hour': '1 час', 'mute.day': '1 день', 'mute.week': 'неделю', 'mute.forever': 'навсегда', 'mute.on': 'Включить звук',
    'muteopt.1h': '1 час', 'muteopt.3h': '3 часа', 'muteopt.12h': '12 часов', 'muteopt.1d': '1 день', 'muteopt.3d': '3 дня', 'muteopt.7d': '7 дней', 'muteopt.1mo': '1 месяц', 'muteopt.forever': 'Навсегда',
    'presence.online': 'в сети', 'presence.recently': 'был(а) недавно', 'presence.lastSeen': 'был(а) в сети {ago} назад', 'presence.offline': 'не в сети',
    'presence.subs': '{n} подписчиков', 'presence.membersN': '{n} участников', 'presence.onlineN': '{n} в сети',
    'unit.year': 'г', 'unit.month': 'мес', 'unit.week': 'нед', 'unit.day': 'д', 'unit.hour': 'ч', 'unit.min': 'м', 'ago.less': 'меньше минуты',
    'word.channel': 'канал', 'word.group': 'группа', 'and': 'и',
    'reaction.failed': 'Не удалось поставить реакцию: {e}', 'paid.title': '👻 Донат автору поста', 'paid.hint': 'Отправьте призраков автору — платная реакция. Ваш баланс: {n} 👻',
    'paid.custom': 'Своё…', 'paid.customTitle': 'Донат призраками', 'paid.customHint': 'Сколько 👻 отправить автору?', 'paid.sent': 'Отправлено {n} 👻 автору', 'paid.failed': 'Не удалось отправить донат: {e}',
    'paid.dmTitle': '👻 Донат призраками', 'paid.dmHint': 'Отправьте призраков собеседнику {who} как платную реакцию. Ваш баланс: {n} 👻',
    'react.more': 'Ещё эмодзи', 'react.add': 'Добавить реакцию',
    'emoji.recent': 'Недавние', 'emoji.search': '🔍 Поиск эмодзи', 'emoji.empty': 'Ничего не найдено',
    'emoji.cat.people': 'Смайлы и люди', 'emoji.cat.nature': 'Животные и природа', 'emoji.cat.food': 'Еда и напитки', 'emoji.cat.activity': 'Активности',
    'emoji.cat.travel': 'Путешествия', 'emoji.cat.objects': 'Предметы', 'emoji.cat.symbols': 'Символы', 'emoji.cat.flags': 'Флаги',
    'toast.linkCopied': 'Ссылка скопирована', 'toast.sendErr': 'Ошибка отправки: {e}', 'toast.copied': 'Скопировано',
    'share.hint': 'Ссылка-приглашение скопирована — перешлите её. По клику откроется Prizrak и предложит вступить (или вставьте её в «＋ Чат»). {link}',
    'decode.one': '⚠️ Сообщение не удалось расшифровать (сессия обновляется…)', 'decode.many': '⚠️ {n} стар. сообщений не удалось расшифровать (сессия обновляется…)',
    'newchat.title': 'Новый чат или ссылка', 'newchat.hint': 'user:domain или prizrak://join/…', 'newgroup.title': 'Новая группа', 'newgroup.hint': 'Название', 'newgroup.ph': 'Друзья',
    'newchannel.title': 'Новый канал', 'newchannel.ph': 'Объявления', 'forward.title': 'Переслать', 'forward.hint': 'Переслать {n} {msg} — кому? user:domain',
    'msg.messageN.one': 'сообщение', 'msg.messageN.few': 'сообщения', 'msg.messageN.many': 'сообщений',
    'lang.ru': 'Русский', 'lang.en': 'English',
    'preview.voice': '🎤 Голосовое', 'preview.photo': '🖼 Фото', 'preview.file': '📎 Файл', 'preview.you': 'Вы: ',
    'cm.notifOn': 'Включить уведомления', 'cm.notifOff': 'Выключить уведомления', 'cm.separateWindow': 'Открыть в отдельном окне', 'cm.copySel': 'Копировать выделенное',
    'mute.h1': '1 час', 'mute.h8': '8 часов', 'mute.d3': '3 дня', 'mute.foreverItem': 'Навсегда',
    'menu.download': 'Скачать', 'menu.saveToPc': 'Сохранить на компьютер', 'menu.unselect': 'Снять выделение',
    'op.purchase': 'Покупка призраков', 'op.giftIn': 'Подарок получен', 'op.giftOut': 'Подарок отправлен', 'op.adminAdjust': 'Корректировка администратором', 'op.adminZero': 'Обнуление администратором', 'op.welcome': 'Приветственный бонус', 'op.generic': 'Операция',
    'who.payment': 'Платёж', 'who.from': 'От', 'who.to': 'Кому', 'who.reason': 'Причина', 'who.details': 'Детали',
    'status.serverDown': 'Сервер недоступен', 'status.keyUnavail': 'ключ недоступен: ', 'status.error': 'Ошибка: ',
    'set.checking': 'Проверяю…',
    'fwd.title': 'Переслать сообщение', 'fwd.hint': 'Кому переслать? user:domain', 'members.loadFail': 'Не удалось загрузить участников',
    'contacts.add': 'Добавить контакт', 'contacts.emptyHint': 'Пока нет контактов. Нажмите «＋ Добавить контакт».', 'calls.emptyHint': 'История звонков появится здесь. Начните звонок из чата кнопкой 📞 или 🎥.',
    'call.micMuted': '🔇 Микрофон выключен', 'mic.noAccess': 'Нет доступа к микрофону: {e}',
    'checkupd.checking': 'Проверяю…', 'checkupd.fail': 'Не удалось проверить: {e}', 'checkupd.avail': 'Доступна версия <b>{v}</b> (у вас {cur}). ', 'checkupd.dl': 'Скачать', 'checkupd.latest': 'У вас последняя версия ({cur}).',
    'checkupd.ready': 'Обновление {v} загружено — нажмите зелёную плашку «Обновить Prizrak».', 'checkupd.downloading': 'Скачиваю обновление… {p}%',
    'upd.button': 'Обновить Prizrak', 'upd.downloading': 'Загрузка обновления… {p}%', 'upd.installing': 'Устанавливаю…', 'upd.readyTitle': 'Версия {v} готова к установке',
  },
};
function detectLang() { try { const l = (navigator.language || 'en').toLowerCase(); return l.startsWith('ru') ? 'ru' : 'en'; } catch { return 'en'; } }
function t(key, params) {
  const lang = state.lang || 'en';
  let s = (I18N[lang] && I18N[lang][key]) ?? (I18N.en[key]) ?? key;
  if (params) for (const k of Object.keys(params)) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
  return s;
}
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  try { document.documentElement.lang = state.lang || 'en'; } catch {}
  const lv = document.getElementById('rowLangVal'); if (lv) lv.textContent = t('lang.' + (state.lang || 'en'));
}
function setLang(lang) {
  state.lang = (lang === 'ru') ? 'ru' : 'en';
  applyI18n(); schedulePersist();
  // Перерисовать динамические места (списки, заголовки, композер).
  try { renderConvList(); } catch {}
  try { const c = state.conversations.get(state.activeId); if (c) { updateChatHeader(c); renderMessages(); } } catch {}
  try { renderCalls && renderCalls(); } catch {}
  try { renderContacts && renderContacts(); } catch {}
}

// ── Универсальный модал ──────────────────────────────────────────────────────
function openModal(title, hint, placeholder, cb) {
  $('modalTitle').textContent = title; $('modalHint').textContent = hint || '';
  $('modalInput').value = ''; $('modalInput').placeholder = placeholder || '';
  $('modal').classList.remove('hidden'); $('modalInput').focus();
  $('modalOk').onclick = () => { const v = $('modalInput').value.trim(); if (v) { $('modal').classList.add('hidden'); cb(v); } };
  $('modalCancel').onclick = () => $('modal').classList.add('hidden');
  $('modalInput').onkeydown = (e) => { if (e.key === 'Enter') $('modalOk').click(); };
}
const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Ссылки в тексте → кликабельные <a.lnk> (открываются в браузере по умолчанию через openExternal).
// Экранируем текст, затем находим URL (http/https/www) и отрезаем хвостовую пунктуацию.

// 🔗 Карточка превью ссылки (как в Telegram). Данные пришли ВНУТРИ сообщения —
// в сеть не ходим, поэтому карточка видна даже если сайт уже умер.
function linkPreviewHtml(p) {
  if (!p || (!p.title && !p.desc)) return '';
  const img = p.image && p.image.data
    ? `<img class="lp-img" src="data:${esc(p.image.mime || 'image/jpeg')};base64,${esc(p.image.data)}" alt=""/>` : '';
  return `<div class="lp-card" data-url="${esc(p.url || '')}">`
    + `<div class="lp-body">`
    + (p.site ? `<div class="lp-site">${esc(p.site)}</div>` : '')
    + (p.title ? `<div class="lp-title">${esc(p.title)}</div>` : '')
    + (p.desc ? `<div class="lp-desc">${esc(p.desc)}</div>` : '')
    + `</div>${img}</div>`;
}
function linkify(raw) {
  const e = esc(raw == null ? '' : String(raw));
  return e.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (m) => {
    const tail = (m.match(/(?:&amp;|&quot;|&#39;|[)\].,!?;:»”"'])+$/) || [''])[0];
    const shown = tail ? m.slice(0, m.length - tail.length) : m;
    if (!shown) return m;
    let url = shown.replace(/&amp;/g, '&');
    const href = /^www\./i.test(url) ? 'http://' + url : url;
    return `<a class="lnk" data-url="${esc(href)}" title="${esc(href)}">${shown}</a>${tail}`;
  });
}
// Клик по ссылке в сообщении → открыть в браузере по умолчанию (не ломая SPA).
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest && ev.target.closest('a.lnk');
  if (!a) return;
  ev.preventDefault(); ev.stopPropagation();
  const u = a.dataset.url; if (u) { try { window.prizrak.openExternal({ url: u }); } catch (e) {} }
});

// ── Тосты вместо нативного alert() ───────────────────────────────────────────
// ВАЖНО: нативный alert()/confirm() из рендерера на Windows ломает фокус ввода —
// после него курсор не встаёт в поля. Поэтому свои неблокирующие уведомления.
function toast(msg) {
  let box = $('toastBox');
  if (!box) { box = document.createElement('div'); box.id = 'toastBox'; box.className = 'toast-box'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = String(msg);
  t.onclick = () => t.remove();
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4200);
}
window.alert = (m) => toast(m); // весь alert() в коде → неблокирующий тост (фикс фокуса на Windows)
// Своё окно подтверждения (Promise<boolean>) вместо нативного confirm().
function confirmAsk(msg) {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal';
    ov.innerHTML = `<div class="modal-card"><div class="modal-title">${esc(t('common.confirm'))}</div><div class="cf-msg"></div><div class="row"><button class="ghost-btn cf-no">${esc(t('common.cancel'))}</button><button class="danger cf-yes">${esc(t('common.yes'))}</button></div></div>`;
    ov.querySelector('.cf-msg').textContent = String(msg);
    const done = (v) => { try { ov.remove(); } catch {} resolve(v); };
    ov.querySelector('.cf-no').onclick = () => done(false);
    ov.querySelector('.cf-yes').onclick = () => done(true);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
    document.body.appendChild(ov);
    setTimeout(() => { try { ov.querySelector('.cf-yes').focus(); } catch {} }, 0);
  });
}
// Нормализация id: по привычке пишут user@domain (как e-mail), а формат
// Prizrak — user:domain (двоеточие). Мягко превращаем одиночный @ в двоеточие.
function normId(s) { s = String(s || '').trim(); if (!s.includes(':') && (s.match(/@/g) || []).length === 1) s = s.replace('@', ':'); return s; }

// ── Галочки доставки/прочтения ────────────────────────────────────────────────
// sent(1)=✓ серая (на своём сервере) · server(2)=✓✓ серые (на сервере получателя)
// received(3)=левая синеет (доставлено в приложение) · read(4)=обе синие (прочитано)
const RECEIPT_RANK = { sent: 1, server: 2, received: 3, read: 4 };
function checksHtml(status) {
  if (status === 'queued') return `<span class="ticks" title="Сервер получателя недоступен — сообщение в очереди, будет доставлено автоматически">🕐</span>`;
  const r = RECEIPT_RANK[status] || 0;
  if (r === 0) return '';
  if (r === 1) return `<span class="ticks"><span class="tk grey">✓</span></span>`;
  const left = r >= 3 ? 'blue' : 'grey', right = r >= 4 ? 'blue' : 'grey';
  return `<span class="ticks two"><span class="tk ${left}">✓</span><span class="tk ${right} tk2">✓</span></span>`;
}
function updateReceipts(from, msgIds, status) {
  // 'server' (дошло до сервера получателя) сохраняем как есть; прочие — по рангу.
  const target = RECEIPT_RANK[status] ? status : 'received';
  const ids = new Set(msgIds || []);
  for (const c of state.conversations.values()) {
    if (c.type !== 'direct' || c.peerId !== from) continue;
    let changed = false;
    for (const m of c.messages) if (m.mine && m.msgId && ids.has(m.msgId) && (RECEIPT_RANK[m.status] || 0) < RECEIPT_RANK[target]) { m.status = target; changed = true; }
    if (changed) { if (c.id === state.activeId) renderMessages(); schedulePersist(); }
  }
}
// Статус исходящего по ответу сервера: очередь / дошло до сервера получателя / только своё.
function sendStatus(r) { return r && r.queued ? 'queued' : (r && r.delivered ? 'server' : 'sent'); }
function markPeerRead(c) {
  if (!c || c.type !== 'direct') return;
  const ids = c.messages.filter((m) => !m.mine && m.msgId).map((m) => m.msgId);
  if (ids.length) { try { window.prizrak.markRead({ peerId: c.peerId, msgIds: ids }); } catch {} }
}

// ── Вход ─────────────────────────────────────────────────────────────────────
// Адрес выбранного сервера (пресет или «Свой сервер»).
function serverBaseUrl() { const s = $('serverSel').value; return s === 'custom' ? $('customServer').value.trim() : s; }
function hostDomain(url) { try { return new URL(/^\w+:\/\//.test(url) ? url : 'http://' + url).hostname; } catch { return String(url || '').replace(/^\w+:\/\//, '').split(/[:/]/)[0]; } }
let _srvDomain = '', _resolvedBase = '';
function updateUidDomain() {
  $('uidDomain').textContent = _srvDomain ? ':' + _srvDomain : '';
  const login = $('login').value.trim().replace(/^@/, '').split(':')[0];
  $('uidPreview').textContent = (login && _srvDomain) ? (login + ':' + _srvDomain) : '';
}
async function refreshServerInfo() {
  const baseUrl = serverBaseUrl(); const info = $('serverInfo');
  _resolvedBase = ''; _srvDomain = hostDomain(baseUrl); updateUidDomain();
  if (!baseUrl) { info.textContent = ''; return; }
  info.textContent = t('auth.checking');
  try {
    const cfg = await window.prizrak.config({ baseUrl });
    _resolvedBase = cfg.baseUrl || baseUrl;               // рабочий адрес с найденным портом
    _srvDomain = cfg.domain || _srvDomain; updateUidDomain();
    info.innerHTML = `<span style="color:var(--ok)">✓ ${esc(t('auth.serverUp'))}</span> · ` +
      (cfg.registrationEnabled ? `<span style="color:var(--ok)">${esc(t('auth.regOpen'))}</span>` : `<span style="color:var(--danger)">${esc(t('auth.regClosed'))}</span>`);
    $('inviteRow').classList.toggle('hidden', !cfg.requiresInvite);
    $('btnRegister').disabled = !cfg.registrationEnabled;
  } catch { info.innerHTML = `<span style="color:var(--danger)">${esc(t('auth.serverDown'))}</span>`; $('btnRegister').disabled = false; }
}
$('serverSel').onchange = () => { $('customServer').classList.toggle('hidden', $('serverSel').value !== 'custom'); if ($('serverSel').value === 'custom') $('customServer').focus(); refreshServerInfo(); };
$('customServer').addEventListener('blur', refreshServerInfo);
$('customServer').addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshServerInfo(); });
$('login').addEventListener('input', updateUidDomain);

async function doAuth(kind) {
  $('authError').textContent = '';
  const baseUrl = _resolvedBase || serverBaseUrl();   // используем адрес с найденным портом
  const login = $('login').value.trim().replace(/^@/, '').split(':')[0];
  const domain = _srvDomain || hostDomain(baseUrl);
  if (!baseUrl || !domain) { $('authError').textContent = t('auth.needServer'); return; }
  if (!login) { $('authError').textContent = t('auth.needLogin'); return; }
  const pw = $('password').value;
  if (kind === 'register') {
    if (pw.length < 8) { $('authError').textContent = t('auth.pwShort'); return; }
    if (pw !== $('password2').value) { $('authError').textContent = t('auth.pwMismatch'); return; }
  }
  // Логин сразу становится и отображаемым именем (его можно сменить в профиле).
  const a = { baseUrl, userId: `${login}:${domain}`, name: login, password: pw, inviteCode: $('inviteCode')?.value.trim() };
  try {
    const res = kind === 'register' ? await window.prizrak.register(a) : await window.prizrak.login(a);
    enterApp({ userId: res.userId, isAdmin: res.isAdmin, fingerprint: res.fingerprint });
  } catch (e) { $('authError').textContent = e.message; }
}
$('btnRegister').onclick = () => doAuth('register');
$('btnLogin').onclick = () => doAuth('login');
refreshServerInfo(); // проверить доступность выбранного по умолчанию сервера при открытии

// ── B2: копия аккаунта — экспорт (настройки) и восстановление (логин) ─────────
function _mkModal(inner) {
  const ov = document.createElement('div'); ov.className = 'modal';
  ov.innerHTML = `<div class="modal-card">${inner}</div>`;
  document.body.appendChild(ov);
  const close = () => { try { ov.remove(); } catch {} };
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  return { ov, close };
}
function openBackupExport() {
  const { ov, close } = _mkModal(`
    <div class="modal-title">${esc(t('acct.exportTitle'))}</div>
    <div class="hint">${esc(t('acct.exportHint'))}</div>
    <label>${esc(t('acct.pw'))}</label><input type="password" id="bkPw">
    <label>${esc(t('acct.pw2'))}</label><input type="password" id="bkPw2">
    <div id="bkErr" style="color:var(--danger);font-size:12px;min-height:14px"></div>
    <div class="row"><button class="primary" id="bkGo">${esc(t('acct.make'))}</button><button class="ghost-btn" id="bkNo">${esc(t('common.cancel'))}</button></div>`);
  ov.querySelector('#bkNo').onclick = close;
  ov.querySelector('#bkGo').onclick = async () => {
    const pw = ov.querySelector('#bkPw').value, pw2 = ov.querySelector('#bkPw2').value;
    const err = ov.querySelector('#bkErr');
    if (pw.length < 6) { err.textContent = t('acct.pwShort'); return; }
    if (pw !== pw2) { err.textContent = t('auth.pwMismatch'); return; }
    const r = await window.prizrak.accountExport({ password: pw });
    if (r && r.saved) { close(); toast(t('acct.saved')); }
    else if (r && r.canceled) { /* пользователь отменил сохранение */ }
    else err.textContent = (r && r.error) || 'error';
  };
}
async function openRestoreFlow() {
  const picked = await window.prizrak.accountPickFile();
  if (!picked || picked.canceled) return;
  if (picked.error) { $('authError').textContent = picked.error; return; }
  const { ov, close } = _mkModal(`
    <div class="modal-title">${esc(t('acct.restoreTitle'))}</div>
    <div class="hint">${esc(picked.userId)}</div>
    <label>${esc(t('acct.server'))}</label><input type="text" id="rsSrv" value="${esc(picked.baseUrl || serverBaseUrl())}">
    <label>${esc(t('acct.filePw'))}</label><input type="password" id="rsFilePw">
    <label>${esc(t('acct.accPw'))}</label><input type="password" id="rsAccPw">
    <div id="rsErr" style="color:var(--danger);font-size:12px;min-height:14px"></div>
    <div class="row"><button class="primary" id="rsGo">${esc(t('acct.restoreBtn'))}</button><button class="ghost-btn" id="rsNo">${esc(t('common.cancel'))}</button></div>`);
  ov.querySelector('#rsNo').onclick = close;
  ov.querySelector('#rsGo').onclick = async () => {
    const baseUrl = ov.querySelector('#rsSrv').value.trim();
    const filePassword = ov.querySelector('#rsFilePw').value;
    const accountPassword = ov.querySelector('#rsAccPw').value;
    const err = ov.querySelector('#rsErr'); err.textContent = t('auth.checking');
    const r = await window.prizrak.accountImport({ baseUrl, filePassword, accountPassword });
    if (r && r.userId) { close(); enterApp({ userId: r.userId, isAdmin: r.isAdmin, fingerprint: r.fingerprint }); }
    else err.textContent = (r && r.error) || 'error';
  };
}
$('authRestore').onclick = (e) => { e.preventDefault(); openRestoreFlow(); };
$('setBackup').onclick = openBackupExport;

// ── B3: фраза восстановления — показ (настройки) и восстановление (логин) ─────
async function openSeedShow() {
  const r = await window.prizrak.seedEnable();
  if (!r || r.error) { toast((r && r.error) || 'error'); return; }
  const { ov, close } = _mkModal(`
    <div class="modal-title">${esc(t('seed.title'))}</div>
    <div class="hint">${esc(t('seed.hint'))}</div>
    <div class="seed-words">${esc(r.mnemonic)}</div>
    <div class="hint" style="color:var(--danger)">${esc(t('seed.warn'))}</div>
    <div class="row"><button class="primary" id="sdCopy">${esc(t('seed.copy'))}</button><button class="ghost-btn" id="sdOk">${esc(t('common.done'))}</button></div>`);
  ov.querySelector('#sdOk').onclick = close;
  ov.querySelector('#sdCopy').onclick = () => { copyText(r.mnemonic); toast(t('seed.copied')); };
}
async function openSeedRecover() {
  const { ov, close } = _mkModal(`
    <div class="modal-title">${esc(t('seed.recoverTitle'))}</div>
    <label>${esc(t('acct.server'))}</label><input type="text" id="sdSrv" value="${esc(serverBaseUrl())}">
    <label>${esc(t('auth.username'))}</label><input type="text" id="sdLogin" placeholder="alice">
    <label>${esc(t('seed.phrase'))}</label><textarea id="sdPhrase" rows="3" style="width:100%;resize:vertical"></textarea>
    <label>${esc(t('seed.newPw'))}</label><input type="password" id="sdPw">
    <label>${esc(t('acct.pw2'))}</label><input type="password" id="sdPw2">
    <div id="sdErr" style="color:var(--danger);font-size:12px;min-height:14px"></div>
    <div class="row"><button class="primary" id="sdGo">${esc(t('acct.restoreBtn'))}</button><button class="ghost-btn" id="sdNo">${esc(t('common.cancel'))}</button></div>`);
  ov.querySelector('#sdNo').onclick = close;
  ov.querySelector('#sdGo').onclick = async () => {
    const err = ov.querySelector('#sdErr');
    const baseUrl = ov.querySelector('#sdSrv').value.trim();
    const login = ov.querySelector('#sdLogin').value.trim().replace(/^@/, '').split(':')[0];
    const domain = hostDomain(baseUrl);
    const mnemonic = ov.querySelector('#sdPhrase').value;
    const pw = ov.querySelector('#sdPw').value, pw2 = ov.querySelector('#sdPw2').value;
    if (!login || !domain) { err.textContent = t('auth.needServer'); return; }
    if (pw.length < 8) { err.textContent = t('auth.pwShort'); return; }
    if (pw !== pw2) { err.textContent = t('auth.pwMismatch'); return; }
    err.textContent = t('auth.checking');
    const r = await window.prizrak.seedRecover({ baseUrl, userId: `${login}:${domain}`, mnemonic, newPassword: pw });
    if (r && r.userId) { close(); enterApp({ userId: r.userId, isAdmin: r.isAdmin, fingerprint: r.fingerprint }); }
    else err.textContent = (r && r.error) || 'error';
  };
}
$('authRestoreSeed').onclick = (e) => { e.preventDefault(); openSeedRecover(); };
$('setSeed').onclick = openSeedShow;

// ── MD6: экран «Устройства» ──────────────────────────────────────────────────
async function openDevices() {
  const { ov, close } = _mkModal(`
    <div class="modal-title">${esc(t('dev.title'))}</div>
    <div id="devList" class="dev-list"><div class="hint">${esc(t('common.loading'))}</div></div>
    <div class="row"><button class="ghost-btn" id="dvClose">${esc(t('common.close'))}</button></div>`);
  ov.querySelector('#dvClose').onclick = close;
  const render = async () => {
    const box = ov.querySelector('#devList');
    let r; try { r = await window.prizrak.devicesList(); } catch { r = { devices: [] }; }
    const devs = (r && r.devices) || [];
    if (!devs.length) { box.innerHTML = `<div class="hint">${esc(t('dev.none'))}</div>`; return; }
    devs.sort((a, b) => (b.current - a.current) || (a.addedAt - b.addedAt));
    box.innerHTML = devs.map((d) => {
      const when = d.addedAt ? new Date(d.addedAt).toLocaleDateString() : '';
      const name = esc(d.name || d.deviceId);
      const badge = d.current ? `<span class="dev-cur">${esc(t('dev.current'))}</span>` : `<button class="ghost-btn dev-revoke" data-id="${esc(d.deviceId)}">${esc(t('dev.revoke'))}</button>`;
      return `<div class="dev-row"><div class="dev-ic">💻</div><div class="dev-meta"><div class="dev-name">${name}</div><div class="dev-sub">${esc(t('dev.added'))}: ${esc(when)} · <span class="mono">${esc(d.deviceId)}</span></div></div>${badge}</div>`;
    }).join('');
    box.querySelectorAll('.dev-revoke').forEach((b) => b.onclick = async () => {
      b.disabled = true; try { await window.prizrak.deviceRevoke({ deviceId: b.getAttribute('data-id') }); toast(t('dev.revoked')); } catch (e) { alert(e.message); }
      render();
    });
  };
  render();
}
$('setDevices').onclick = openDevices;

async function enterApp(me) {
  state.me = me;
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('meName').textContent = me.userId + (me.isAdmin ? '  ·  админ' : '');
  $('meFp').textContent = 'safety-number ' + me.fingerprint;
  $('btnAdmin').classList.toggle('hidden', !me.isAdmin);
  await refreshWallet();
  // Баланс призраков живёт в Банке (не пушится homeserver'ом) — опрашиваем раз в минуту.
  if (!state._walletPoll) state._walletPoll = setInterval(() => { refreshWallet().catch(() => {}); }, 60000);
  // Восстановить локальный кэш переписки (история после перезапуска)
  try { const ui = await window.prizrak.loadUI(); if (ui?.conversations) for (const c of ui.conversations) state.conversations.set(c.id, c); if (ui?.theme) state.theme = ui.theme; if (typeof ui?.notif === 'boolean') state.notif = ui.notif; if (typeof ui?.sound === 'boolean') state.sound = ui.sound; if (Array.isArray(ui?.emojiRecent)) state.emojiRecent = ui.emojiRecent; if (ui?.lang === 'ru' || ui?.lang === 'en') state.lang = ui.lang; if (typeof ui?.linkPreviews === 'boolean') state.linkPreviews = ui.linkPreviews; } catch {}
  if (!state.lang) state.lang = detectLang(); // по умолчанию — язык системы (EN, если не русский)
  applyI18n();
  applyTheme(state.theme);
  try { window.prizrak.setNotif({ enabled: state.notif }); } catch {}
  // Свой аватар/имя в сайдбаре
  try { const p = await window.prizrak.getProfile({ userId: me.userId }); const a = avatarUrl(p.avatar); if (a) $('meAva').innerHTML = `<img src="${a}" alt="">`; if (p.displayName) $('meName').textContent = p.displayName + (me.isAdmin ? '  ·  админ' : ''); } catch {}
  try { for (const r of await window.prizrak.listRooms()) ensureConv(r.id, { type: r.type, title: r.name, roomId: r.id }); } catch {}
  syncMuted(); // сообщить main про замьюченные чаты
  renderConvList();
  resumeTransfers(); // подтянуть прогресс незавершённых передач файлов после перезахода
  switchTab('chats');
  // Рендерер готов принимать realtime — main отдаст накопленные «догонялки»
  // (сообщения, пришедшие пока приложение стартовало после автологина).
  try { window.prizrak.rendererReady(); } catch {}
  initUpdateBar(); // показать зелёную плашку, если обновление уже готово
}

// ── Локальный кэш (история переживает перезапуск) ────────────────────────────
let persistTimer = null;
function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => { try { window.prizrak.persistUI({ conversations: [...state.conversations.values()], theme: state.theme, notif: state.notif, sound: state.sound, emojiRecent: state.emojiRecent, lang: state.lang, linkPreviews: state.linkPreviews }); } catch {} }, 600); }

// ── Кошелёк 👻 / «Мои призраки» ───────────────────────────────────────────────
async function refreshWallet() {
  try { const w = await window.prizrak.wallet(); state.balance = w.balance; } catch {}
  const txt = `👻 ${state.balance}`;
  $('ghostBalance').textContent = txt;
  const gh = $('ghBalance'); if (gh) gh.textContent = txt;
  const rv = $('rowGhostsVal'); if (rv) rv.textContent = txt;
}
// Покупка призраков: Банк создаёт платёж в PayMoney и возвращает payment_url,
// main открывает его в браузере. После оплаты (IPN Банку) баланс подтянется.
function buyFlow() {
  openModal('Купить призраков', 'Сколько призраков купить? Минимум 50.', '100', async (v) => {
    const n = Math.floor(Number(v)); if (!(n >= 50)) return alert('Минимум 50 👻');
    try {
      const r = await window.prizrak.ghostsBuy({ amount: n });
      if (r && r.payment_url) {
        alert(`Открываю оплату в браузере: ${n} 👻 за ${r.amount}. После оплаты баланс обновится автоматически.`);
        let tries = 0; const t = setInterval(async () => { await refreshWallet(); if (++tries >= 20) clearInterval(t); }, 3000);
      } else { alert('Не удалось создать платёж' + (r && r.error ? ': ' + r.error : '. Проверьте, что Банк доступен.')); }
    } catch (e) { alert('Ошибка покупки: ' + e.message); }
  });
}
function giftFlow(defaultTo) {
  openModal('Подарить призраков', 'Кому отправить? Формат user:domain', defaultTo || 'bob:example.org', (raw) => {
    const to = normId(raw);
    openModal('Сколько призраков подарить', `Получатель: ${to}. С вашего баланса: 👻 ${state.balance}.`, '10', async (v) => {
      try { await window.prizrak.ghostsSend({ to, amount: Number(v) }); await refreshWallet(); if (!$('ghostsScreen').classList.contains('hidden')) openGhostsScreen(); alert(`Отправлено ${v} 👻 → ${to}`); }
      catch (e) { alert('Ошибка: ' + e.message); }
    });
  });
}

// ── Экран «Баланс Призраков» с историей операций ──────────────────────────────
const OP_KIND = {
  purchase: { icon: '🛒', label: 'op.purchase', who: 'who.payment' },
  'gift-in': { icon: '🎁', label: 'op.giftIn', who: 'who.from' },
  'gift-out': { icon: '🎁', label: 'op.giftOut', who: 'who.to' },
  'admin-adjust': { icon: '🛠', label: 'op.adminAdjust', who: 'who.reason' },
  'admin-zero': { icon: '🛠', label: 'op.adminZero', who: 'who.reason' },
  welcome: { icon: '✨', label: 'op.welcome', who: '' },
};
function opMeta(kind) { const o = OP_KIND[kind]; return o ? { icon: o.icon, label: t(o.label), who: o.who ? t(o.who) : '' } : { icon: '👻', label: kind || t('op.generic'), who: t('who.details') }; }
function fmtDateTime(sec) { const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} в ${p(d.getHours())}:${p(d.getMinutes())}`; }
async function openGhostsScreen() {
  $('ghostsScreen').classList.remove('hidden');
  $('ghostsOps').innerHTML = '<div class="hint" style="padding:12px">Загрузка…</div>';
  let h = { balance: state.balance, ops: [] };
  try { h = await window.prizrak.ghostsHistory(); } catch {}
  state.balance = h.balance; refreshWallet();
  $('gsBalance').textContent = `👻 ${h.balance}`; $('gsAvail').textContent = h.balance;
  const box = $('ghostsOps'); box.innerHTML = '';
  if (!h.ops.length) { box.innerHTML = '<div class="hint" style="padding:12px">Пока нет операций. Купите или получите призраков.</div>'; return; }
  for (const op of h.ops) {
    const m = opMeta(op.kind); const pos = op.delta >= 0;
    const row = document.createElement('div'); row.className = 'gs-op';
    row.innerHTML = `<div class="gs-op-ic">${m.icon}</div>
      <div class="gs-op-meta"><div class="gs-op-title">${esc(m.label)}</div><div class="gs-op-sub">${esc(fmtDateTime(op.at))}${op.ref ? ' · ' + esc(String(op.ref)) : ''}</div></div>
      <div class="gs-op-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}${op.delta} 👻</div>`;
    row.onclick = () => openOpModal(op);
    box.appendChild(row);
  }
  loadMyNodes();
}
async function loadMyNodes() {
  const box = $('myNodes'); if (!box) return;
  let r = { nodes: [] };
  try { r = await window.prizrak.nodesMine(); } catch {}
  if (!r.nodes || !r.nodes.length) { box.innerHTML = '<div class="hint">Пока нет привязанных узлов.</div>'; return; }
  box.innerHTML = '';
  for (const n of r.nodes) {
    const row = document.createElement('div'); row.className = 'gs-op';
    row.innerHTML = `<div class="gs-op-ic">${n.online ? '🟢' : '⚪'}</div>
      <div class="gs-op-meta"><div class="gs-op-title">${esc(n.short)}… <span class="gs-op-sub">${esc(n.group || '')}</span></div>
      <div class="gs-op-sub">аптайм ${n.uptimeHours} ч · доставок ${n.deliveries}${n.payable > 0 ? ' · к выплате ' + n.payable : ''}</div></div>
      <div class="gs-op-amt pos">👻 ${n.accrued}</div>`;
    box.appendChild(row);
  }
}
async function bindNodeFlow() {
  const inp = $('nodeBindCode'); const code = (inp.value || '').trim();
  if (!code) return;
  const btn = $('nodeBindBtn'); btn.disabled = true;
  try {
    const r = await window.prizrak.nodesBind({ code });
    if (r && r.error) { toast('Ошибка привязки: ' + r.error); }
    else { inp.value = ''; loadMyNodes(); toast('Узел привязан! Награды пойдут на ваш баланс.'); }
  } catch (e) { toast('Ошибка: ' + (e.message || e)); }
  finally { btn.disabled = false; }
}
function openOpModal(op) {
  const m = opMeta(op.kind); const pos = op.delta >= 0;
  $('opHero').textContent = m.icon;
  $('opAmount').textContent = `${pos ? '+' : ''}${op.delta} 👻`; $('opAmount').className = 'op-amount ' + (pos ? 'pos' : 'neg');
  $('opDesc').textContent = m.label;
  $('opWhoK').textContent = m.who || 'Детали';
  $('opWho').textContent = op.ref || '—';
  $('opId').textContent = 'OP-' + op.id;
  $('opDate').textContent = fmtDateTime(op.at);
  $('opModal').classList.remove('hidden');
}
$('opClose').onclick = $('opDone').onclick = () => $('opModal').classList.add('hidden');
$('ghBack').onclick = () => $('ghostsScreen').classList.add('hidden');
$('gsBuy').onclick = buyFlow;
$('gsGift').onclick = () => giftFlow();
$('nodeBindBtn').onclick = bindNodeFlow;

// Вход в экран баланса: клик по кошельку в сайдбаре или пункт «Мои призраки».
$('walletChip').onclick = openGhostsScreen;
$('rowGhosts').onclick = openGhostsScreen;
if ($('rowSendGift')) $('rowSendGift').onclick = pickGiftRecipient;
// Оставляем и быстрый модал «Мои призраки» (кнопки внутри него).
$('ghClose').onclick = () => $('ghostsModal').classList.add('hidden');
$('ghBuy').onclick = buyFlow;
$('ghGift').onclick = () => giftFlow();
$('btnGift').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type !== 'direct') return;
  openModal('Подарить 👻', `Отправить призраков пользователю ${c.peerId}`, '10', async (v) => {
    try { await window.prizrak.ghostsSend({ to: c.peerId, amount: Number(v) }); await refreshWallet(); pushMessage(c.id, { system: true, text: `Вы отправили ${v} 👻` }); }
    catch (e) { pushMessage(c.id, { system: true, text: 'Ошибка: ' + e.message }); }
  });
};

// ── Диалоги ──────────────────────────────────────────────────────────────────
function ensureConv(id, opts) {
  if (!state.conversations.has(id)) state.conversations.set(id, { id, messages: [], ...opts });
  else Object.assign(state.conversations.get(id), opts);
  return state.conversations.get(id);
}
const icon = (t) => t === 'channel' ? '📢' : t === 'group' ? '👥' : '💬';
function isChatMuted(c) { return c.mutedUntil && (c.mutedUntil === -1 || c.mutedUntil > Date.now()); }
function syncMuted() {
  const map = {}; for (const c of state.conversations.values()) if (isChatMuted(c)) map[c.id] = c.mutedUntil;
  try { window.prizrak.setMuted(map); } catch {}
}
// ── Бейдж непрочитанных на иконке приложения (dock macOS / overlay Windows) ──
// Число = ВСЕ непрочитанные (беззвучные + с уведомлениями). Цвет: красный, если
// есть непрочитанные в чатах с уведомлениями; серый — если остались только
// беззвучные. Системный бейдж дока всегда красный, поэтому на macOS рисуем
// значок прямо на иконке дока (нужна копия иконки — renderer/appicon.png).
const BADGE_RED = '#f23f42', BADGE_GRAY = '#8b93a7';
const _badgeIcon = new Image(); let _badgeIconReady = false;
_badgeIcon.onload = () => { _badgeIconReady = true; };
try { _badgeIcon.src = 'appicon.png'; } catch {}
function badgeText(n) { return n > 999 ? '999+' : String(n); }
function pillWidth(hh, txt) { const r = hh / 2; return Math.max(hh, r * 1.2 + txt.length * hh * 0.42); }
// Нарисовать овал с числом, левый-верхний угол (x,y), высота hh.
function drawPillAt(ctx, x, y, hh, txt, color) {
  const w = pillWidth(hh, txt), r = hh / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(hh * 0.6)}px -apple-system, Segoe UI, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, x + w / 2, y + hh / 2 + 1);
}
// Overlay для панели задач Windows — только значок (масштабируем под длину числа).
function makeOverlayDataUrl(n, color) {
  const S = 64, txt = badgeText(n), L = txt.length;
  const hh = Math.min(46, Math.floor((S - 4) / (0.6 + 0.42 * L)));
  const w = pillWidth(hh, txt), cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  drawPillAt(cv.getContext('2d'), (S - w) / 2, (S - hh) / 2, hh, txt, color);
  return cv.toDataURL('image/png');
}
// Иконка дока macOS — базовая иконка + значок в правом верхнем углу.
function makeDockDataUrl(n, color) {
  const S = 256, cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  if (_badgeIconReady) { try { ctx.drawImage(_badgeIcon, 0, 0, S, S); } catch {} }
  const hh = 82, txt = badgeText(n), w = pillWidth(hh, txt);
  drawPillAt(ctx, S - w - 6, 6, hh, txt, color);
  return cv.toDataURL('image/png');
}
let _lastBadge = '';
function updateAppBadge() {
  let muted = 0, unmuted = 0;
  for (const c of state.conversations.values()) { const u = c.unread || 0; if (!u) continue; if (isChatMuted(c)) muted += u; else unmuted += u; }
  const total = muted + unmuted;
  const color = unmuted > 0 ? BADGE_RED : (muted > 0 ? BADGE_GRAY : null);
  const sig = total + '|' + (color || '');
  if (sig === _lastBadge) return; _lastBadge = sig;
  try {
    window.prizrak.setBadge({
      count: total, red: color === BADGE_RED,
      overlay: total > 0 ? makeOverlayDataUrl(total, color) : null,
      dock: total > 0 ? makeDockDataUrl(total, color) : null,
    });
  } catch {}
}
function renderConvList() {
  const list = $('convList'); list.innerHTML = '';
  const q = (state.search || '').toLowerCase();
  // Архив сверху (если есть архивированные).
  const archived = [...state.conversations.values()].filter((c) => c.archived);
  if (archived.length) {
    const a = document.createElement('div'); a.className = 'conv archive-row';
    a.innerHTML = `<div class="avatar">🗄</div><div class="meta"><div class="name">Архив</div><div class="last">${archived.length} чат(ов)</div></div>`;
    a.onclick = () => { state.showArchived = !state.showArchived; renderConvList(); };
    list.appendChild(a);
  }
  const items = [...state.conversations.values()]
    .filter((c) => (state.showArchived ? c.archived : !c.archived))
    .filter((c) => !q || String(c.title).toLowerCase().includes(q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  for (const c of items) {
    const d = document.createElement('div'); d.className = 'conv' + (c.id === state.activeId ? ' active' : '');
    const last = c.messages[c.messages.length - 1];
    const preview = last ? (last.text || (last.attachment ? (last.attachment.voice ? `${t('preview.voice')}${last.attachment.dur ? ' ' + fmtDur(last.attachment.dur) : ''}` : (isImage(last.attachment) ? t('preview.photo') : t('preview.file'))) : '')) : (c.type || 'chat');
    const av = c.avatar ? `<img src="${avatarUrl(c.avatar)}" alt="">` : icon(c.type);
    const marks = `${c.pinned ? '<span class="cmark">📌</span>' : ''}${isChatMuted(c) ? '<span class="cmark">🔕</span>' : ''}`;
    const unread = c.unread > 0 ? `<span class="unread${isChatMuted(c) ? ' muted' : ''}">${c.unread > 999 ? '999+' : c.unread}</span>` : '';
    d.innerHTML = `<div class="avatar">${av}</div><div class="meta"><div class="name">${esc(c.title)}${c.verified ? ' <span class="vmark">✓</span>' : ''}</div>
      <div class="last">${esc((last?.mine ? t('preview.you') : '') + preview)}</div></div>
      <div class="conv-right">${marks}${c.type && c.type !== 'direct' ? `<span class="badge">${c.type === 'channel' ? t('word.channel') : t('word.group')}</span>` : ''}${unread}</div>`;
    d.onclick = () => selectConv(c.id);
    d.oncontextmenu = (e) => openChatMenu(e, c);
    list.appendChild(d);
  }
  updateAppBadge(); // обновить счётчик на иконке приложения
}
// Контекстное меню чата (ПКМ): закрепить, уведомления, архив, отдельное окно, удалить.
function openChatMenu(e, c) {
  e.preventDefault();
  const items = [];
  items.push({ icon: '📌', label: c.pinned ? t('menu.unpin') : t('menu.pin'), action: () => { c.pinned = !c.pinned; renderConvList(); schedulePersist(); } });
  items.push({ icon: isChatMuted(c) ? '🔔' : '🔕', label: isChatMuted(c) ? t('cm.notifOn') : t('cm.notifOff'), action: () => {
    // Уже без звука → включаем сразу; иначе — модалка с выбором длительности.
    if (isChatMuted(c)) { c.mutedUntil = 0; syncMuted(); renderConvList(); schedulePersist(); }
    else openMuteModal(c);
  } });
  items.push({ icon: '🗄', label: c.archived ? t('menu.unarchive') : t('menu.archive'), action: () => { c.archived = !c.archived; renderConvList(); schedulePersist(); } });
  items.push({ icon: '🪟', label: t('cm.separateWindow'), action: () => { try { window.prizrak.openWindow({ id: c.id, type: c.type, title: c.title, peerId: c.peerId, roomId: c.roomId }); } catch {} } });
  items.push({ sep: true });
  items.push({ icon: '🗑', label: t('menu.deleteChat'), danger: true, action: () => {
    state.conversations.delete(c.id); if (state.activeId === c.id) { state.activeId = null; updateChatHeader(null); $('messages').innerHTML = ''; } renderConvList(); schedulePersist();
  } });
  showCtxMenu(e.clientX, e.clientY, items);
}
// Модалка «Отключить уведомления на…» — для личных чатов, групп и каналов.
function openMuteModal(c) {
  const opts = [
    ['muteopt.1h', 3600e3], ['muteopt.3h', 3 * 3600e3], ['muteopt.12h', 12 * 3600e3], ['muteopt.1d', 86400e3],
    ['muteopt.3d', 3 * 86400e3], ['muteopt.7d', 7 * 86400e3], ['muteopt.1mo', 30 * 86400e3], ['muteopt.forever', -1],
  ];
  const ov = document.createElement('div'); ov.className = 'modal';
  const btns = opts.map(([k, ms]) => `<button class="mute-opt${ms < 0 ? ' forever' : ''}" data-ms="${ms}">${esc(t(k))}</button>`).join('');
  ov.innerHTML = `<div class="modal-card"><div class="modal-title">${esc(t('mute.title'))}</div>
    <div class="mute-opts">${btns}</div>
    <div class="row"><button class="ghost-btn mm-no">${esc(t('common.cancel'))}</button></div></div>`;
  document.body.appendChild(ov);
  const done = () => { try { ov.remove(); } catch {} };
  ov.querySelector('.mm-no').onclick = done;
  ov.onclick = (e) => { if (e.target === ov) done(); };
  ov.querySelectorAll('.mute-opt').forEach((b) => b.onclick = () => {
    const ms = Number(b.getAttribute('data-ms'));
    c.mutedUntil = ms < 0 ? -1 : Date.now() + ms;
    syncMuted(); renderConvList(); schedulePersist();
    try { const ri = $('roomInfoScreen'); if (ri && !ri.classList.contains('hidden')) renderRoomInfo(c); } catch {}
    done();
  });
}
// ── Шапка чата: аватар + имя + статус (presence / участники онлайн) ──────────
function plural(n, one, few, many) { const a = n % 10, b = n % 100; if (a === 1 && b !== 11) return one; if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few; return many; }
function fmtAgo(sec) {
  if ((state.lang || 'en') === 'ru') {
    const units = [[365 * 86400, 'год', 'года', 'лет'], [30 * 86400, 'месяц', 'месяца', 'месяцев'], [7 * 86400, 'неделю', 'недели', 'недель'], [86400, 'день', 'дня', 'дней'], [3600, 'час', 'часа', 'часов'], [60, 'минуту', 'минуты', 'минут']];
    const parts = []; let rem = sec;
    for (const [s, one, few, many] of units) { const n = Math.floor(rem / s); if (n > 0) { parts.push(`${n} ${plural(n, one, few, many)}`); rem -= n * s; } if (parts.length >= 4) break; }
    if (!parts.length) return t('ago.less');
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(' ') + ' ' + t('and') + ' ' + parts[parts.length - 1];
  }
  // EN и прочие — компактные сокращения (1y 2mo 3w 4d)
  const units = [[365 * 86400, 'unit.year'], [30 * 86400, 'unit.month'], [7 * 86400, 'unit.week'], [86400, 'unit.day'], [3600, 'unit.hour'], [60, 'unit.min']];
  const parts = []; let rem = sec;
  for (const [s, k] of units) { const n = Math.floor(rem / s); if (n > 0) { parts.push(n + t(k)); rem -= n * s; } if (parts.length >= 4) break; }
  return parts.length ? parts.join(' ') : t('ago.less');
}
function formatPresence(p) {
  if (!p || p.unknown) return { text: '', cls: '' };
  if (p.online) return { text: t('presence.online'), cls: 'online' };
  const ts = p.lastSeen || 0;
  if (!ts) return { text: t('presence.recently'), cls: '' };
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 15 * 60) return { text: t('presence.recently'), cls: '' };
  return { text: t('presence.lastSeen', { ago: fmtAgo(diff) }), cls: '' };
}
function setDirectStatus(c) { const el = $('chatStatus'); const f = formatPresence(c._presence); el.textContent = f.text || '…'; el.className = 'chat-status' + (f.cls ? ' ' + f.cls : ''); }
function setRoomStatus(c) {
  const el = $('chatStatus'); el.className = 'chat-status';
  const total = c._room ? roomParticipants(c._room) : null;
  const online = c._room ? (c._room.online || 0) : null;
  if (total == null) { el.textContent = c.type === 'channel' ? t('word.channel') : t('word.group'); return; }
  const noun = c.type === 'channel' ? t('presence.subs', { n: total }) : t('presence.membersN', { n: total });
  el.textContent = noun + (online ? ', ' + t('presence.onlineN', { n: online }) : '');
}
function updateChatHeader(c) {
  if (!c) { $('chatAva').innerHTML = ''; $('chatTitle').textContent = t('chat.pick'); $('chatStatus').textContent = ''; $('chatStatus').className = 'chat-status'; return; }
  $('chatAva').innerHTML = c.avatar ? `<img src="${avatarUrl(c.avatar)}" alt="">` : icon(c.type);
  $('chatTitle').textContent = c.title || '';
  if (c.type === 'direct') setDirectStatus(c); else setRoomStatus(c);
}
let headerTimer = null;
async function refreshHeaderStatus(c) {
  if (!c) return;
  if (c.type === 'direct') { try { c._presence = await window.prizrak.presence({ userId: c.peerId }); } catch {} if (state.activeId === c.id) setDirectStatus(c); }
  else { try { c._room = await window.prizrak.roomGet({ roomId: c.roomId }); } catch {} if (state.activeId === c.id) setRoomStatus(c); }
}
function startHeaderPoll(c) {
  if (headerTimer) { clearInterval(headerTimer); headerTimer = null; }
  if (!c) return;
  refreshHeaderStatus(c);
  headerTimer = setInterval(() => { const cur = state.conversations.get(state.activeId); if (cur) refreshHeaderStatus(cur); else { clearInterval(headerTimer); headerTimer = null; } }, 45000);
}
$('chatHead').onclick = () => { const c = state.conversations.get(state.activeId); if (!c) return; if (c.type === 'direct') $('btnViewProfile').onclick(); else openRoomInfo(c); };
$('chatHead').style.cursor = 'pointer';
function selectConv(id) {
  state.activeId = id; const c = state.conversations.get(id);
  const hadUnread = c.unread > 0;
  c.unread = 0; // открыли чат — обнуляем непрочитанные
  if (hadUnread) { try { window.prizrak.syncRead({ convId: c.id }); } catch {} } // MD4: сообщить своим устройствам
  updateChatHeader(c); startHeaderPoll(c);
  const isDirect = c.type === 'direct';
  $('btnSearch').classList.remove('hidden'); // поиск по чату — во всех типах
  closeChatSearch(); // при смене чата закрываем поиск
  $('btnCall').classList.toggle('hidden', !isDirect);
  $('btnVideo').classList.toggle('hidden', !isDirect);
  $('btnGift').classList.toggle('hidden', !isDirect);
  $('btnGiftShop').classList.toggle('hidden', !isDirect);
  $('btnInvite').classList.toggle('hidden', isDirect);
  $('btnRetention').classList.toggle('hidden', isDirect);
  $('btnShare').classList.toggle('hidden', isDirect);
  $('btnRoomEdit').classList.toggle('hidden', isDirect);
  $('btnViewProfile').classList.toggle('hidden', !isDirect);
  $('btnMembers').classList.toggle('hidden', isDirect);
  state.selected.clear(); updateDelBar();
  $('msgInput').disabled = false; $('btnSend').disabled = false;
  renderMessages(); renderConvList();
  if (isDirect) { loadPeerProfile(c); markPeerRead(c); }
  else loadRoomInfo(c); // подтянуть состав/права → права на запись + экран инфо
  if (c.type === 'channel') loadChannelHistory(c);
  else if (c.type === 'group') loadRoomReactions(c); // реакции в группах — как в каналах
  refreshComposer();
}
// Публичные данные комнаты (состав, роли, описание) — для прав записи и экрана «инфо».
async function loadRoomInfo(c) {
  try { const room = await window.prizrak.roomGet({ roomId: c.roomId }); c._room = room; if (room.description) c.description = room.description; }
  catch {}
  if (state.activeId === c.id) { refreshComposer(); setRoomStatus(c); renderMessages(); if (!$('roomInfoScreen').classList.contains('hidden')) renderRoomInfo(c); }
}
// Подтянуть реакции для всех сообщений комнаты (канал/группа).
async function loadRoomReactions(c) {
  if (!c || c.type === 'direct') return;
  try {
    const rx = await window.prizrak.channelReactions({ roomId: c.roomId });
    let changed = false;
    for (const mm of c.messages) if (mm.msgId && rx[mm.msgId]) { mm.reactions = rx[mm.msgId]; changed = true; }
    if (changed && state.activeId === c.id) renderMessages();
  } catch {}
}
function canPostRoom(room) {
  if (!room) return false; const me = state.me.userId;
  if (room.type === 'group') { if (room.readOnly) return room.owner === me || (room.admins || []).includes(me); return (room.members || []).includes(me); }
  return room.owner === me || (room.admins || []).includes(me); // канал — вещают админы/владелец
}
function isRoomMember(room) {
  if (!room) return false; const me = state.me.userId;
  return [room.owner, ...(room.admins || []), ...(room.moderators || []), ...(room.members || []), ...(room.subscribers || [])].includes(me);
}
function roomParticipants(room) {
  return new Set([room.owner, ...(room.admins || []), ...(room.moderators || []), ...(room.members || []), ...(room.subscribers || [])].filter(Boolean)).size;
}
// Композер виден, только если можно писать и мы не в режиме выделения.
function refreshComposer() {
  const c = state.conversations.get(state.activeId);
  const comp = document.querySelector('.composer'); const lock = $('composerLock');
  const selecting = state.selected.size > 0;
  let canPost;
  if (!c) canPost = true;
  else if (c.type === 'direct') canPost = true;
  else if (!c._room) canPost = c.type !== 'channel'; // до загрузки: группа можно, канал — нет
  else canPost = canPostRoom(c._room);
  if (comp) comp.style.display = (selecting || !canPost) ? 'none' : '';
  if (lock) lock.classList.toggle('hidden', selecting || canPost || !c || c.type !== 'channel');
}
async function loadChannelHistory(c) {
  try {
    if (!c._room) { try { c._room = (await window.prizrak.listRooms()).find((x) => x.id === c.roomId) || c._room; } catch {} }
    if (!c._room) { try { const r = await window.prizrak.roomGet({ roomId: c.roomId }); if (r && r.id) c._room = r; } catch {} } // федеративная комната
    const posts = await window.prizrak.getChannelHistory({ roomId: c.roomId });
    let added = false;
    for (const p of posts) {
      if (p.error || !p.msgId) continue;
      if (c.messages.some((m) => m.msgId === p.msgId)) continue;
      c.messages.push({ from: p.from, mine: p.from === state.me.userId, text: p.text, msgId: p.msgId, time: '' });
      added = true;
    }
    let rxChanged = false;
    try { const rx = await window.prizrak.channelReactions({ roomId: c.roomId }); for (const mm of c.messages) if (mm.msgId && rx[mm.msgId]) { mm.reactions = rx[mm.msgId]; rxChanged = true; } } catch {}
    if (added || rxChanged) { if (state.activeId === c.id) renderMessages(); renderConvList(); schedulePersist(); }
  } catch {}
}
function pluralMsg(n) { if ((state.lang || 'en') !== 'ru') return n === 1 ? t('msg.messageN.one') : t('msg.messageN.many'); const a = n % 10, b = n % 100; if (a === 1 && b !== 11) return t('msg.messageN.one'); if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return t('msg.messageN.few'); return t('msg.messageN.many'); }
function updateDelBar() {
  const n = state.selected.size;
  $('selBar').classList.toggle('hidden', n === 0);
  refreshComposer(); // учитывает и режим выделения, и права на запись в канале
  if (n) $('selCount').textContent = t('sel.selected', { n }) + ' ' + pluralMsg(n);
}
$('selDelete').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  openDeleteModal(c.messages.filter((m) => m.msgId && state.selected.has(m.msgId)), c);
};
$('selForward').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  const msgs = c.messages.filter((m) => (m.msgId || m.text) && state.selected.has(m.msgId));
  if (!msgs.length) return;
  openModal(t('forward.title'), t('forward.hint', { n: msgs.length, msg: pluralMsg(msgs.length) }), 'bob:example.org', async (raw) => {
    const to = normId(raw); ensureConv(to, { type: 'direct', title: to, peerId: to });
    for (const m of msgs) { if (!m.text) continue; try { const r = await window.prizrak.sendDirect({ peerId: to, text: m.text }); pushMessage(to, { mine: true, text: m.text, time: now(), msgId: r && r.msgId }); } catch (e) { alert('Не переслать: ' + e.message); break; } }
    state.selected.clear(); updateDelBar(); renderMessages(); renderConvList();
  });
};
// Подтянуть профиль собеседника (аватар/имя) при открытии чата
async function loadPeerProfile(c) {
  try {
    const p = await window.prizrak.getProfile({ userId: c.peerId }); c._profile = p;
    if (p.avatar) c.avatar = p.avatar;
    if (p.displayName && p.displayName !== c.peerId.split(':')[0]) c.title = p.displayName;
    if (state.activeId === c.id) updateChatHeader(c);
    try { const s = await window.prizrak.safetyStatus({ userId: c.peerId }); c.verified = s.status === 'verified'; } catch {}
    renderConvList(); schedulePersist();
  } catch {}
}
// ── Поиск по истории чата + кнопка «в самый низ» (как в Telegram) ─────────────
const _cs = { open: false, q: '', hits: [], idx: -1 };
// Подсветить вхождения запроса в уже экранированном HTML текста (без риска сломать <a>).
function csMarkup(html) {
  const q = _cs.open && _cs.q.trim();
  if (!q || html.includes('<a')) return html;
  const eq = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return html.replace(new RegExp(eq, 'gi'), (s) => `<mark class="cs-mark">${s}</mark>`); } catch { return html; }
}
function msgSearchText(m) {
  if (m.text) return String(m.text);
  if (m.attachment && m.attachment.filename) return String(m.attachment.filename);
  return '';
}
function chatSearchRun() {
  const c = state.conversations.get(state.activeId);
  _cs.q = $('csInput').value; _cs.hits = []; _cs.idx = -1;
  const q = _cs.q.trim().toLowerCase();
  if (c && q.length >= 1) {
    c.messages.forEach((m, i) => { if (!m.system && msgSearchText(m).toLowerCase().includes(q)) _cs.hits.push(i); });
  }
  if (_cs.hits.length) _cs.idx = _cs.hits.length - 1; // начинаем с самого свежего совпадения
  renderMessages();
  chatSearchFocus(false);
  $('csCount').textContent = _cs.hits.length ? `${_cs.idx + 1}/${_cs.hits.length}` : (q ? '0' : '');
}
function chatSearchFocus(scrollSmooth = true) {
  document.querySelectorAll('.msg.search-hit').forEach((el) => el.classList.remove('search-hit'));
  if (_cs.idx < 0 || !_cs.hits.length) return;
  const el = document.querySelector(`.msg[data-mi="${_cs.hits[_cs.idx]}"]`);
  if (el) { el.classList.add('search-hit'); el.scrollIntoView({ block: 'center', behavior: scrollSmooth ? 'smooth' : 'auto' }); }
  $('csCount').textContent = `${_cs.idx + 1}/${_cs.hits.length}`;
}
function chatSearchStep(dir) {
  if (!_cs.hits.length) return;
  _cs.idx = (_cs.idx + dir + _cs.hits.length) % _cs.hits.length;
  chatSearchFocus();
}
function closeChatSearch() {
  if (!_cs.open) return;
  _cs.open = false; _cs.q = ''; _cs.hits = []; _cs.idx = -1;
  $('chatSearchBar').classList.add('hidden'); $('csInput').value = ''; $('csCount').textContent = '';
  renderMessages();
}
$('btnSearch').onclick = () => {
  if (_cs.open) { closeChatSearch(); return; }
  _cs.open = true; $('chatSearchBar').classList.remove('hidden');
  setTimeout(() => $('csInput').focus(), 50);
};
let _csTimer = null;
$('csInput').oninput = () => { clearTimeout(_csTimer); _csTimer = setTimeout(chatSearchRun, 250); };
$('csInput').onkeydown = (e) => { if (e.key === 'Enter') chatSearchStep(e.shiftKey ? 1 : -1); if (e.key === 'Escape') closeChatSearch(); };
$('csPrev').onclick = () => chatSearchStep(-1); // раньше (вверх по истории)
$('csNext').onclick = () => chatSearchStep(1);  // позже
$('csClose').onclick = closeChatSearch;
document.addEventListener('keydown', (e) => { // Ctrl/Cmd+F в открытом чате → поиск
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.activeId) { e.preventDefault(); if (!_cs.open) $('btnSearch').onclick(); else $('csInput').focus(); }
});

// Кнопка «в самый низ»: появляется, когда прокрутили вверх.
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  const far = box.scrollHeight - box.scrollTop - box.clientHeight > 300;
  $('scrollDown').classList.toggle('hidden', !far);
});
$('scrollDown').onclick = () => { const box = $('messages'); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); };

function renderMessages() {
  const box = $('messages'); box.innerHTML = ''; const c = state.conversations.get(state.activeId); if (!c) return;
  const selMode = state.selected.size > 0;
  let mi = 0;
  for (const m of c.messages) {
    const d = document.createElement('div');
    d.className = 'msg ' + (m.system ? 'system' : m.mine ? 'mine' : 'other');
    d.dataset.mi = mi++; // индекс сообщения (для поиска по чату)
    if (m.uploading) {
      d.classList.add('uploading');
      const pct = m.percent || 0, R = 16, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
      d.innerHTML = `<div class="up-row">
        <div class="up-ring"><svg width="40" height="40">
          <circle class="track" cx="20" cy="20" r="${R}" fill="none" stroke-width="3"/>
          <circle class="bar" cx="20" cy="20" r="${R}" fill="none" stroke-width="3" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
          <div class="x" data-cancel="${esc(m.uploadId)}" title="Отменить">✕</div></div>
        <div class="up-meta"><div class="up-name">${esc(m.filename)}</div><div class="up-sub">Загрузка… ${pct}%</div></div>
      </div>`;
      const x = d.querySelector('[data-cancel]'); if (x) x.onclick = (e) => { e.stopPropagation(); cancelUpload(m.uploadId); };
      box.appendChild(d); continue;
    }
    if (m.system) {
      d.innerHTML = `<span class="sys-text">${esc(m.text)}</span><span class="sys-x" title="Убрать">✕</span>`;
      d.querySelector('.sys-x').onclick = (e) => { e.stopPropagation(); c.messages = c.messages.filter((x) => x !== m); renderMessages(); renderConvList(); schedulePersist(); };
      d.oncontextmenu = (e) => openMsgMenu(e, m, c);
      box.appendChild(d); continue;
    }
    if (m.gift) {
      // 🎁 Подарок: крупный эмодзи + название + сообщение.
      const g = m.gift;
      const sub = m.mine ? t('gift.youSent', { n: g.name }) : (g.anon ? t('gift.anonSent', { n: g.name }) : t('gift.gotFrom', { n: g.name }));
      d.innerHTML = `<div class="gift-bubble gift-open" title="${esc(t('gift.tapOpen'))}"><div class="gb-em">${esc(g.emoji || '🎁')}</div><div class="gb-t">${esc(sub)}</div>${g.msg ? `<div class="gb-m">«${esc(g.msg)}»</div>` : ''}<div class="gb-m">🎁 ${Number(g.price) || 0} 👻</div><div class="gb-hint">${esc(t('gift.tapOpen'))}</div></div><div class="time">${m.time || ''}${m.mine && c.type === 'direct' ? checksHtml(m.status) : ''}</div>`;
      if (m.msgId) { d.classList.add('selectable'); }
      const gbEl = d.querySelector('.gift-bubble');
      if (gbEl) gbEl.onclick = () => openGiftInfo(m, c);
      d.oncontextmenu = (e) => openMsgMenu(e, m, c);
      box.appendChild(d); continue;
    }
    if (m.attachment) {
      const who = !m.mine && c.type !== 'direct' ? `<div class="who">${esc(m.from)}</div>` : '';
      const att = m.attachment;
      if (att.voice) {
        renderVoice(d, m, att, c); // голосовое — только в личных чатах, «who» не нужен
      } else if (isImage(att)) {
        renderImageAtt(d, m, att, c, who); // картинка — превью + клик = открыть в окне
      } else if (isAudio(att)) {
        renderAudioAtt(d, m, att, c, who); // аудио (.mp3 и т.п.) — инлайн-плеер с Play
      } else {
        let ctrl;
        if (m.dlActive) {
          const pct = m.dlPercent || 0, R = 14, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
          ctrl = `<div class="up-ring sm"><svg width="34" height="34"><circle class="track" cx="17" cy="17" r="${R}" fill="none" stroke-width="3"/><circle class="bar" cx="17" cy="17" r="${R}" fill="none" stroke-width="3" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg><div class="x" data-dlcancel="1" title="Отменить">✕</div></div>`;
        } else if (m.dlPath) {
          ctrl = `<div class="dl-ic saved" data-open="1" title="Сохранить на компьютер">💾</div>`;
        } else {
          ctrl = `<div class="dl-ic" data-download="1" title="Скачать">⬇</div>`;
        }
        const fchecks = m.mine && c.type === 'direct' ? checksHtml(m.status) : '';
        const xfer = m._txPct != null ? `<div class="att-xfer">↗ Передача получателю ${m._txPct}%</div>` : '';
        d.innerHTML = `${who}<div class="att file"${m.dlPath ? ' title="Скачано — можно перетащить мышью"' : ''}><span class="ic">📎</span><div class="att-meta"><div class="att-name">${esc(att.filename || 'файл')}</div>${att.size ? `<div class="att-size">${fmtSize(att.size)}${m.dlPath ? ' · в кэше' : ''}</div>` : ''}${xfer}</div>${ctrl}</div><div class="time">${m.time || ''}${fchecks}</div>`;
        const db = d.querySelector('[data-download]'); if (db) db.onclick = (e) => { e.stopPropagation(); startDownload(m); };
        const cb = d.querySelector('[data-dlcancel]'); if (cb) cb.onclick = (e) => { e.stopPropagation(); cancelDownload(m); };
        const ob = d.querySelector('[data-open]'); if (ob) ob.onclick = (e) => { e.stopPropagation(); openDownloaded(m); };
        if (m.dlPath) enableDragOut(d.querySelector('.att.file'), m); // тянуть скачанный файл наружу
      }
    } else {
      const who = !m.mine && c.type !== 'direct' ? `<div class="who">${esc(m.from)}</div>` : '';
      d.innerHTML = `${who}<div class="mtext">${csMarkup(linkify(m.text))}</div>${linkPreviewHtml(m.preview)}<div class="time">${m.time || ''}${m.mine && c.type === 'direct' ? checksHtml(m.status) : ''}</div>`;
      const lp = d.querySelector('.lp-card');
      if (lp) lp.onclick = (e) => { e.stopPropagation(); try { window.prizrak.openExternal({ url: lp.getAttribute('data-url') }); } catch {} };
    }
    if (m.msgId) {
      d.classList.add('selectable');
      if (state.selected.has(m.msgId)) d.classList.add('selected');
      if (selMode) {
        d.classList.add('selmode');
        const chk = document.createElement('span'); chk.className = 'sel-check' + (state.selected.has(m.msgId) ? ' on' : '');
        chk.textContent = state.selected.has(m.msgId) ? '✓' : '';
        d.appendChild(chk);
        d.onclick = () => toggleSelect(m.msgId); // в режиме выделения тап переключает
      }
    }
    d.oncontextmenu = (e) => openMsgMenu(e, m, c);
    renderReactions(d, m, c); // реакции под постом канала
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

// ── Контекстное меню сообщения (ПКМ) ─────────────────────────────────────────
function hideCtxMenu() { const m = $('ctxMenu'); if (m) m.classList.add('hidden'); }
function showCtxMenu(x, y, items, reactions) {
  const menu = $('ctxMenu'); menu.innerHTML = '';
  // Ряд реакций НАД меню (как в Telegram) — если реакции включены в канале.
  if (reactions && reactions.length) {
    const row = document.createElement('div'); row.className = 'ctx-reactions';
    for (const r of reactions) {
      const b = document.createElement('button'); b.className = 'ctx-rx' + (r.paid ? ' paid' : '') + (r.on ? ' on' : '');
      b.textContent = r.emoji; if (r.title) b.title = r.title;
      b.onclick = (ev) => { ev.stopPropagation(); hideCtxMenu(); r.action(); };
      row.appendChild(b);
    }
    menu.appendChild(row);
  }
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('div'); b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ci">${it.icon || ''}</span><span>${esc(it.label)}</span>`;
    b.onclick = () => { hideCtxMenu(); it.action(); };
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
}
// Собрать ряд реакций для ПКМ-меню поста канала (эмодзи канала + платная 👻).
function reactionRowFor(m, c) {
  if (!c || !m.msgId || m.system) return null;
  // Личные чаты: реакции всегда доступны. Донат 👻 — только на сообщения собеседника.
  if (c.type === 'direct') {
    const mine = (m.reactions && m.reactions.mine) || [];
    const row = [];
    for (const em of DEFAULT_RX) row.push({ emoji: em, on: mine.includes(em), action: () => reactToggle(c, m, em) });
    if (!m.mine) row.push({ emoji: '👻', paid: true, title: t('paid.dmTitle'), action: () => openPaidReactionDirect(c, m) });
    return row;
  }
  const room = c._room || {};
  const freeOn = room.reactionsEnabled !== false;
  const paidOn = !!room.paidReactionsEnabled;
  if (!freeOn && !paidOn) return null;
  const mine = (m.reactions && m.reactions.mine) || [];
  const row = [];
  if (freeOn) {
    const emojis = (room.reactionEmojis && room.reactionEmojis.length) ? room.reactionEmojis : DEFAULT_RX;
    for (const em of emojis) row.push({ emoji: em, on: mine.includes(em), action: () => toggleReactionOn(c, m, em) });
  }
  if (paidOn) row.push({ emoji: '👻', paid: true, title: t('paid.title'), action: () => openPaidReaction(c, m) });
  return row.length ? row : null;
}
document.addEventListener('click', hideCtxMenu);
document.addEventListener('scroll', hideCtxMenu, true);
async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch {} }
function openMsgMenu(e, m, c) {
  e.preventDefault();
  const sel = String(window.getSelection() || '');
  const items = [];
  if (m.text) {
    if (sel) items.push({ icon: '📋', label: t('cm.copySel'), action: () => copyText(sel) });
    items.push({ icon: '📄', label: t('menu.copy'), action: () => copyText(m.text) });
    items.push({ icon: '➡️', label: t('menu.forward'), action: () => forwardMessage(m) });
  }
  if (m.attachment && !m.attachment.voice) {
    items.push({ icon: '⬇', label: m.dlPath ? t('menu.saveToPc') : t('menu.download'), action: () => (m.dlPath ? openDownloaded(m) : startDownload(m)) });
    items.push({ icon: '➡️', label: t('menu.forward'), action: () => forwardMessage(m) });
  }
  if (m.msgId) items.push({ icon: '☑️', label: state.selected.has(m.msgId) ? t('menu.unselect') : t('menu.select'), action: () => toggleSelect(m.msgId) });
  items.push({ sep: true });
  if (m.msgId) items.push({ icon: '🗑', label: t('menu.delete'), danger: true, action: () => deleteOne(m, c) });
  else items.push({ icon: '🗑', label: t('menu.remove'), danger: true, action: () => { c.messages = c.messages.filter((x) => x !== m); renderMessages(); renderConvList(); schedulePersist(); } });
  showCtxMenu(e.clientX, e.clientY, items, reactionRowFor(m, c));
}
function forwardMessage(m) {
  openModal(t('fwd.title'), t('fwd.hint'), 'bob:example.org', async (raw) => {
    const to = normId(raw);
    ensureConv(to, { type: 'direct', title: to, peerId: to });
    try {
      if (m.attachment && !m.attachment.voice) {
        const r = await window.prizrak.forwardAttachment({ peerId: to, attachment: m.attachment });
        pushMessage(to, { mine: true, attachment: m.attachment, time: now(), msgId: r && r.msgId });
      } else {
        const r = await window.prizrak.sendDirect({ peerId: to, text: m.text });
        pushMessage(to, { mine: true, text: m.text, time: now(), msgId: r && r.msgId });
      }
      renderConvList();
    } catch (err) { alert('Не удалось переслать: ' + err.message); }
  });
}
function deleteOne(m, c) { openDeleteModal([m], c); }

// Модалка удаления «у меня / у всех» (как в Telegram).
function openDeleteModal(msgs, c) {
  msgs = msgs.filter(Boolean); if (!msgs.length || !c) return;
  $('delTitle').textContent = msgs.length > 1 ? `Удалить ${msgs.length} сообщений?` : 'Удалить сообщение?';
  const hasServer = msgs.some((m) => m.msgId);
  $('delAll').checked = false;
  $('delAllRow').style.display = hasServer ? '' : 'none';
  $('delModal').classList.remove('hidden');
  $('delConfirm').onclick = async () => {
    $('delModal').classList.add('hidden');
    const all = $('delAll').checked;
    for (const m of msgs) {
      if (all && m.msgId) {
        try { await window.prizrak.deleteMessage({ msgId: m.msgId, peer: c.type === 'direct' ? c.peerId : undefined }); }
        catch (e) { if (!(m.mine && /не найдено/i.test(e.message))) { pushMessage(c.id, { system: true, text: 'Не удалить у всех: ' + e.message }); continue; } }
        // Освобождаем место: свой файл — удаляем и медиа-блоб с сервера (mediaId знает клиент).
        if (m.mine && m.attachment && m.attachment.mediaId) { try { await window.prizrak.mediaDelete({ mediaId: m.attachment.mediaId }); } catch {} }
      }
      c.messages = c.messages.filter((x) => x !== m); // удалить локально (у меня)
    }
    state.selected.clear(); updateDelBar(); renderMessages(); renderConvList(); schedulePersist();
  };
  $('delCancel').onclick = () => $('delModal').classList.add('hidden');
}

// ── Картинки: превью (blob, т.к. file:// запрещён CSP) + открыть в окне + drag ──
function isImage(att) { const m = (att.mime || '').toLowerCase(); if (m.startsWith('image/')) return true; return /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(att.filename || ''); }
// Аудио-файл (не голосовое): .mp3 и прочие — показываем инлайн-плеер.
function isAudio(att) { if (att.voice) return false; const m = (att.mime || '').toLowerCase(); if (m.startsWith('audio/')) return true; return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|mid)$/i.test(att.filename || ''); }

// ── Инлайн аудио-плеер для присланных .mp3 (единый на весь список) ─────────────
let _audEl = null, _audMsg = null, _audBtn = null, _audFill = null, _audCur = null, _audUrl = null;
function _audReset() { if (_audBtn) _audBtn.textContent = '▶'; if (_audFill) _audFill.style.width = '0%'; if (_audCur) _audCur.textContent = '0:00'; _audBtn = _audFill = _audCur = null; }
function renderAudioAtt(d, m, att, c, who) {
  const fchecks = m.mine && c.type === 'direct' ? checksHtml(m.status) : '';
  const active = _audMsg === m;
  const playing = active && _audEl && !_audEl.paused;
  d.innerHTML = `${who}<div class="att audio">
      <button class="aud-btn" data-audplay="1">${playing ? '⏸' : '▶'}</button>
      <div class="aud-mid"><div class="aud-name">${esc(att.filename || 'Аудио')}</div>
        <div class="aud-bar"><div class="aud-fill" style="width:${active && _audEl && _audEl.duration ? (_audEl.currentTime / _audEl.duration * 100) : 0}%"></div></div>
        <div class="aud-time"><span class="aud-cur">${active && _audEl ? fmtDur(_audEl.currentTime || 0) : '0:00'}</span>${att.size ? ` · ${fmtSize(att.size)}` : ''}</div></div>
      <div class="dl-ic" data-download="1" title="${t('menu.download')}">⬇</div>
    </div><div class="time">${m.time || ''}${fchecks}</div>`;
  const btn = d.querySelector('[data-audplay]');
  const fill = d.querySelector('.aud-fill');
  const cur = d.querySelector('.aud-cur');
  const bar = d.querySelector('.aud-bar');
  if (active) { _audBtn = btn; _audFill = fill; _audCur = cur; } // переподключаем ссылки после ре-рендера
  btn.onclick = (e) => { e.stopPropagation(); toggleAudio(m, att, btn, fill, cur); };
  bar.onclick = (e) => { if (_audMsg === m && _audEl && _audEl.duration) { const r = bar.getBoundingClientRect(); _audEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * _audEl.duration; } };
  const db = d.querySelector('[data-download]'); if (db) db.onclick = (e) => { e.stopPropagation(); startDownload(m); };
}
async function toggleAudio(m, att, btn, fill, cur) {
  if (_audMsg === m && _audEl) { if (_audEl.paused) { _audEl.play(); btn.textContent = '⏸'; } else { _audEl.pause(); btn.textContent = '▶'; } return; }
  if (_audEl) { try { _audEl.pause(); } catch {} if (_audUrl) { try { URL.revokeObjectURL(_audUrl); } catch {} } _audReset(); _audEl = null; _audMsg = null; }
  btn.textContent = '…';
  let bytes;
  try {
    if (m.dlPath) { const r = await window.prizrak.readFile({ path: m.dlPath }); if (r && r.bytes) bytes = r.bytes; }
    if (!bytes) { const r = await window.prizrak.attachCache({ attachment: att }); if (r && r.bytes) { bytes = r.bytes; if (r.path) m.dlPath = r.path; } else throw new Error((r && r.error) || 'нет данных'); }
  } catch (e) { btn.textContent = '▶'; toast(t('audio.fail', { e: e.message }) || ('Аудио: ' + e.message)); return; }
  _audUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: att.mime || 'audio/mpeg' }));
  const a = new Audio(_audUrl); _audEl = a; _audMsg = m; _audBtn = btn; _audFill = fill; _audCur = cur;
  a.ontimeupdate = () => { if (a.duration && _audFill) { _audFill.style.width = (a.currentTime / a.duration * 100) + '%'; _audCur.textContent = fmtDur(a.currentTime); } };
  a.onplay = () => { if (_audMsg === m && _audBtn) _audBtn.textContent = '⏸'; };
  a.onpause = () => { if (!a.ended && _audMsg === m && _audBtn) _audBtn.textContent = '▶'; };
  a.onended = () => { _audReset(); if (_audUrl) { try { URL.revokeObjectURL(_audUrl); } catch {} _audUrl = null; } _audEl = null; _audMsg = null; };
  try { await a.play(); } catch (e) { btn.textContent = '▶'; }
}
const IMG_AUTO_MAX = 15 * 1024 * 1024; // авто-подгрузка превью для картинок ≤15 МБ
const imgUrls = new Map(); // ключ сообщения → objectURL (живёт только в этой сессии)
function imgKey(m) { return m.msgId || (m._k ||= 'k' + Math.random().toString(16).slice(2)); }
// Нативный drag-out: перетащить скачанный файл (dlPath) в другое приложение/чат.
function enableDragOut(el, m) {
  if (!el || !m.dlPath) return;
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => { e.preventDefault(); try { window.prizrak.dragOut(m.dlPath); } catch {} });
}
// Гарантируем превью: берём байты из кэша (если уже качали) или скачиваем+кэшируем.
async function ensureImagePreview(m) {
  const k = imgKey(m);
  if (imgUrls.has(k) || m._imgLoading) return;
  m._imgLoading = true; m._imgErr = false; if (state.activeId) renderMessages();
  try {
    let bytes;
    if (m.dlPath) { const r = await window.prizrak.readFile({ path: m.dlPath }); if (r && r.bytes) bytes = r.bytes; }
    if (!bytes) { const r = await window.prizrak.attachCache({ attachment: m.attachment }); if (r && r.path) { m.dlPath = r.path; bytes = r.bytes; } else throw new Error((r && r.error) || 'no data'); }
    if (bytes) imgUrls.set(k, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: m.attachment.mime || 'application/octet-stream' })));
  } catch { m._imgErr = true; }
  m._imgLoading = false;
  if (state.activeId) renderMessages(); schedulePersist();
}
function renderImageAtt(d, m, att, c, who) {
  const checks = (m.mine && c.type === 'direct' ? checksHtml(m.status) : '') + (m._txPct != null ? ` <span class="xfer-inline">↗ ${m._txPct}%</span>` : '');
  const url = imgUrls.get(imgKey(m));
  if (url) {
    d.innerHTML = `${who}<div class="img-att" title="Открыть · можно перетащить мышью"><img class="img-thumb" src="${url}" alt="${esc(att.filename || '')}"><div class="img-save" data-save="1" title="Сохранить на компьютер">💾</div></div><div class="time">${m.time || ''}${checks}</div>`;
    const box = d.querySelector('.img-att');
    box.onclick = (e) => { if (e.target.closest('[data-save]')) return; if (m.dlPath) window.prizrak.imageWindow({ path: m.dlPath, title: att.filename || 'Изображение' }); };
    const sv = d.querySelector('[data-save]'); if (sv) sv.onclick = (e) => { e.stopPropagation(); openDownloaded(m); };
    enableDragOut(box, m);
  } else if (m._imgLoading) {
    d.innerHTML = `${who}<div class="img-att"><div class="img-ph loading"><div class="spin"></div></div></div><div class="time">${m.time || ''}${checks}</div>`;
  } else {
    const big = att.size && att.size > IMG_AUTO_MAX;
    d.innerHTML = `${who}<div class="img-att"><div class="img-ph" data-load="1" title="${m._imgErr ? 'Повторить' : 'Загрузить'}"><div class="dl-ic">${m._imgErr ? '↻' : '⬇'}</div>${att.size ? `<div class="img-pct">${fmtSize(att.size)}</div>` : ''}</div></div><div class="time">${m.time || ''}${checks}</div>`;
    const ph = d.querySelector('[data-load]'); if (ph) ph.onclick = (e) => { e.stopPropagation(); ensureImagePreview(m); };
    if (!big && !m._imgErr) queueMicrotask(() => ensureImagePreview(m)); // авто-превью
  }
}

// ── Скачивание вложений в фоне (стрелка → прогресс → «Сохранить как…») ────────
function fmtSize(n) { if (!n) return ''; const u = ['Б', 'КБ', 'МБ', 'ГБ']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }
async function startDownload(m) {
  if (m.dlActive || m.dlPath) { if (m.dlPath) openDownloaded(m); return; }
  m.dlActive = true; m.dlPercent = 0; m.dlId = newUploadId(); if (state.activeId) renderMessages();
  let r; try { r = await window.prizrak.attachDownload({ downloadId: m.dlId, attachment: m.attachment }); } catch (e) { r = { error: e.message }; }
  m.dlActive = false;
  if (r && r.path) m.dlPath = r.path;
  else if (r && r.error) alert('Ошибка скачивания: ' + r.error);
  renderMessages(); schedulePersist();
}
async function cancelDownload(m) { if (m.dlId) { try { await window.prizrak.attachCancelDownload({ downloadId: m.dlId }); } catch {} } }
async function openDownloaded(m) {
  try { const r = await window.prizrak.attachOpen({ path: m.dlPath, filename: m.attachment.filename }); if (r && r.error) alert('Не удалось сохранить: ' + r.error); }
  catch (e) { alert(e.message); }
}
window.prizrak.onDownloadProgress(({ downloadId, percent }) => {
  for (const c of state.conversations.values()) {
    const m = c.messages.find((x) => x.attachment && x.dlId === downloadId && x.dlActive);
    if (m) { m.dlPercent = percent; if (c.id === state.activeId) renderMessages(); break; }
  }
});
function toggleSelect(msgId) { if (state.selected.has(msgId)) state.selected.delete(msgId); else state.selected.add(msgId); updateDelBar(); renderMessages(); }
function removeMessageEverywhere(msgId) {
  state.selected.delete(msgId);
  for (const c of state.conversations.values()) {
    // Если удаляют МОЁ вложение (собеседник нажал «у обоих») — освобождаем мой блоб.
    const victim = c.messages.find((m) => m.msgId === msgId);
    if (victim && victim.mine && victim.attachment && victim.attachment.mediaId) { try { window.prizrak.mediaDelete({ mediaId: victim.attachment.mediaId }); } catch {} }
    const n = c.messages.length; c.messages = c.messages.filter((m) => m.msgId !== msgId); if (c.messages.length !== n && c.id === state.activeId) renderMessages();
  }
  updateDelBar(); renderConvList(); schedulePersist();
}
function pushMessage(convId, msg) { const c = state.conversations.get(convId); if (!c) return; if (msg.at == null) msg.at = Date.now(); c.messages.push(msg); if (c.messages.length > 500) c.messages.splice(0, c.messages.length - 500); if (convId === state.activeId) renderMessages(); renderConvList(); schedulePersist(); }

// ── Автоудаление (G4): локальные копии стираются по сроку комнаты, как на сервере ──
const RETENTION_MS = { '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '2w': 1209600e3, '1mo': 2592000e3, '3mo': 7776000e3, '6mo': 15552000e3, '1y': 31536000e3 };
async function sweepAutoDelete() {
  if (!state.me) return;
  // Освежаем retention всех комнат одним запросом (сервер — источник истины).
  try {
    const rooms = await window.prizrak.listRooms();
    for (const r of rooms) { const c = state.conversations.get(r.id); if (c) c._room = { ...(c._room || {}), ...r }; }
  } catch {}
  const nowT = Date.now(); let changed = false;
  for (const c of state.conversations.values()) {
    const ttl = RETENTION_MS[c._room && c._room.retention]; if (!ttl || !Array.isArray(c.messages)) continue;
    const before = c.messages.length;
    c.messages = c.messages.filter((m) => { if (m.at == null) { m.at = nowT; return true; } return nowT - m.at < ttl; });
    if (c.messages.length !== before) { changed = true; if (state.activeId === c.id) renderMessages(); }
  }
  if (changed) { renderConvList(); schedulePersist(); }
}
setInterval(sweepAutoDelete, 10 * 60 * 1000);
setTimeout(sweepAutoDelete, 25000); // первый проход после старта/логина

// ── Отправка текста ──────────────────────────────────────────────────────────
async function sendActive() {
  const text = $('msgInput').value.trim(); const c = state.conversations.get(state.activeId); if (!text || !c) return;
  $('msgInput').value = ''; autoGrowMsgInput();
  try {
    const previews = state.linkPreviews !== false;   // тумблер в настройках
    if (c.type === 'direct') {
      const r = await window.prizrak.sendDirect({ peerId: c.peerId, text, previews });
      pushMessage(c.id, { mine: true, text, preview: r && r.preview, time: now(), msgId: r && r.msgId, status: sendStatus(r) });
    } else {
      const r = await window.prizrak.sendRoom({ roomId: c.roomId, text, previews });
      pushMessage(c.id, { mine: true, text, preview: r && r.preview, time: now(), msgId: r && r.msgId });
    }
  } catch (e) { pushMessage(c.id, { system: true, text: 'Ошибка отправки: ' + e.message }); }
}
$('btnSend').onclick = sendActive;
// Enter — отправка; Shift+Enter — перенос строки. Во время IME-композиции (e.isComposing) Enter не перехватываем.
$('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendActive(); }
});
// Авто-высота поля ввода: растёт под многострочный/вставленный текст, до max-height из CSS, дальше — скролл.
function autoGrowMsgInput() {
  const el = $('msgInput'); if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
$('msgInput').addEventListener('input', autoGrowMsgInput);

// ── Эмодзи-пикер (системные Unicode, как в Telegram) ─────────────────────────
const EMOJI_CATS = [
  { icon: '😀', name: 'emoji.cat.people', list: '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 💋 🩸 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 👳 👲 🧕 🤵 👰 🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 👯 🧖 🧗 🤺 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 ⛹️ 🏋️ 🚴 🚵 🤸 🤼 🤽 🤾 🤹 🧘 👭 👫 👬 💏 💑 👪' },
  { icon: '🐻', name: 'emoji.cat.nature', list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🦟 🦗 🕷️ 🕸️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐓 🦃 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐀 🐿️ 🦔 🐾 🐉 🐲 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🎍 🎋 🍃 🍂 🍁 🍄 🐚 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌕 🌖 🌗 🌘 🌑 🌒 🌓 🌔 🌙 🌎 🌍 🌏 🪐 💫 ⭐ 🌟 ✨ ⚡ ☄️ 💥 🔥 🌪️ 🌈 ☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💨 💧 💦 ☔ 🌊' },
  { icon: '🍔', name: 'emoji.cat.food', list: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🦴 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️ 🥣 🥡 🥢' },
  { icon: '⚽', name: 'emoji.cat.activity', list: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩' },
  { icon: '✈️', name: 'emoji.cat.travel', list: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 ⛩️ 🌁 🌃 🏙️ 🌄 🌅 🌆 🌇 🌉 🌌 🎆 🎇 🌠' },
  { icon: '💡', name: 'emoji.cat.objects', list: '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🕹️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱️ ⏰ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🧸 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 📊 📈 📉 🗒️ 🗓️ 📆 📅 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓' },
  { icon: '❤️', name: 'emoji.cat.symbols', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ⏏️ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◼️ ◻️ ◾ ◽ ⬛ ⬜ 🟥 🟧 🟨 🟩 🟦 🟪 🟫 🔈 🔇 🔉 🔊 🔔 🔕 📣 📢 💬 💭 🗯️ ♠️ ♣️ ♥️ ♦️ 🃏 🎴 🀄 🕐 🕑 🕒 🕓 🕔 🕕 🕖 🕗 🕘 🕙 🕚 🕛' },
  { icon: '🚩', name: 'emoji.cat.flags', list: '🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️ 🇺🇦 🇷🇺 🇺🇸 🇬🇧 🇩🇪 🇫🇷 🇮🇹 🇪🇸 🇵🇱 🇹🇷 🇨🇳 🇯🇵 🇰🇷 🇮🇳 🇧🇷 🇨🇦 🇦🇺 🇲🇪 🇷🇸 🇧🇾 🇰🇿 🇬🇪 🇦🇲 🇦🇿 🇺🇿 🇳🇱 🇧🇪 🇨🇭 🇦🇹 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇵🇹 🇬🇷 🇨🇿 🇭🇺 🇷🇴 🇧🇬 🇭🇷 🇸🇰 🇸🇮 🇮🇪 🇮🇱 🇦🇪 🇸🇦 🇪🇬 🇲🇽 🇦🇷 🇨🇱 🇨🇴 🇿🇦 🇹🇭 🇻🇳 🇮🇩 🇵🇭 🇲🇾 🇸🇬 🇳🇿' },
];
// Ключевые слова для поиска (RU/EN) — покрывают самые ходовые эмодзи.
const EMOJI_KW = {
  '😀':'smile улыбка','😂':'laugh cry смех плач ржач','🤣':'rofl смех ржач','😊':'blush улыбка','😍':'love heart eyes любовь','🥰':'love любовь','😘':'kiss поцелуй','😎':'cool крутой очки','🤔':'think думать','😢':'cry плач слёзы','😭':'cry плач','😡':'angry злой','🤬':'angry мат злой','😱':'scream шок страх','🥳':'party праздник','😴':'sleep сон','👍':'like thumbs up лайк палец','👎':'dislike thumbs down дизлайк','👏':'clap хлопать аплодисменты','🙏':'pray thanks спасибо молитва','🙌':'hooray ура','💪':'muscle сила','🔥':'fire огонь','❤️':'heart love сердце любовь','🧡':'heart сердце','💛':'heart сердце','💚':'heart сердце','💙':'heart сердце','💜':'heart сердце','🖤':'heart сердце','💔':'broken heart разбитое сердце','💯':'100 сотка','🎉':'party tada праздник','🎂':'cake торт день рождения','🎁':'gift подарок','⭐':'star звезда','✨':'sparkles блеск','⚡':'lightning молния','☀️':'sun солнце','🌈':'rainbow радуга','💩':'poop какашка','👻':'ghost призрак привидение','💀':'skull череп','🤖':'robot робот','👽':'alien пришелец','🐶':'dog собака','🐱':'cat кот','🦊':'fox лиса','🐻':'bear медведь','🦁':'lion лев','🐸':'frog лягушка','🦄':'unicorn единорог','🐝':'bee пчела','🦋':'butterfly бабочка','🌹':'rose роза цветок','🌸':'flower цветок','🍏':'apple яблоко','🍎':'apple яблоко','🍌':'banana банан','🍓':'strawberry клубника','🍕':'pizza пицца','🍔':'burger бургер','🍟':'fries картошка','🌮':'taco','🍣':'sushi суши','🍰':'cake торт','☕':'coffee кофе','🍺':'beer пиво','🍷':'wine вино','⚽':'football футбол мяч','🏀':'basketball баскетбол','🎮':'game игра','🎲':'dice кости','🎯':'target цель дартс','🏆':'trophy кубок','🎸':'guitar гитара','🎧':'headphones наушники','🚗':'car машина','✈️':'plane самолёт','🚀':'rocket ракета','🏠':'home дом','💰':'money деньги','💵':'money доллар деньги','💎':'diamond алмаз','💡':'idea bulb идея','🔔':'bell колокол','📱':'phone телефон','💻':'laptop ноутбук','✅':'check ok галочка да','❌':'cross no нет крест','❓':'question вопрос','❗':'exclamation восклицание','⛔':'stop стоп','🚩':'flag флаг','🎃':'pumpkin halloween тыква','🌍':'earth земля мир','🌙':'moon луна','🍄':'mushroom гриб','🐍':'snake змея','🐢':'turtle черепаха','🦖':'dino динозавр','🌵':'cactus кактус','🌊':'wave волна вода','❄️':'snow снег','☃️':'snowman снеговик' };

let emojiCat = 0, emojiTarget = null;
function insertAtCursor(inp, text) {
  const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, s) + text + inp.value.slice(e);
  const pos = s + text.length; inp.selectionStart = inp.selectionEnd = pos; inp.focus();
}
function pushRecentEmoji(em) {
  state.emojiRecent = [em, ...state.emojiRecent.filter((x) => x !== em)].slice(0, 32);
  schedulePersist();
}
function renderEmojiPanel(query = '') {
  const panel = $('emojiPanel');
  const q = query.trim().toLowerCase();
  const recentLbl = t('emoji.recent');
  let html = '<div class="emoji-search"><input id="emojiSearch" type="text" placeholder="' + esc(t('emoji.search')) + '" value="' + esc(query) + '"></div><div class="emoji-scroll">';
  const cell = (em) => `<button data-em="${esc(em)}" title="${esc(em)}">${em}</button>`;
  if (q) {
    const hits = [];
    for (const c of EMOJI_CATS) for (const em of c.list.split(' ')) { const kw = EMOJI_KW[em]; if (kw && kw.includes(q)) hits.push(em); }
    html += hits.length ? `<div class="emoji-grid">${[...new Set(hits)].map(cell).join('')}</div>` : `<div class="emoji-empty">${esc(t('emoji.empty'))}</div>`;
  } else {
    if (state.emojiRecent.length) html += `<div class="emoji-cat-t" data-cat="recent">${esc(recentLbl)}</div><div class="emoji-grid">${state.emojiRecent.map(cell).join('')}</div>`;
    for (const c of EMOJI_CATS) html += `<div class="emoji-cat-t" data-cat="${esc(c.name)}">${esc(t(c.name))}</div><div class="emoji-grid">${c.list.split(' ').map(cell).join('')}</div>`;
  }
  html += '</div><div class="emoji-tabs">' + (state.emojiRecent.length ? `<button data-jump="recent" title="${esc(recentLbl)}">🕐</button>` : '') +
    EMOJI_CATS.map((c, i) => `<button data-jump="${esc(c.name)}" title="${esc(t(c.name))}" class="${i === emojiCat ? 'on' : ''}">${c.icon}</button>`).join('') + '</div>';
  panel.innerHTML = html;
  panel.querySelectorAll('[data-em]').forEach((b) => b.onclick = () => {
    const em = b.getAttribute('data-em');
    if (emojiTarget === 'reactset') { reactAddEmoji(em); pushRecentEmoji(em); } // добавить в набор реакций канала (панель не закрываем)
    else if (emojiTarget === 'reaction') { addReactionEmoji(em); closeEmoji(); }
    else { insertAtCursor($('msgInput'), em); autoGrowMsgInput(); pushRecentEmoji(em); }
  });
  panel.querySelectorAll('[data-jump]').forEach((b) => b.onclick = () => {
    const name = b.getAttribute('data-jump');
    const t = [...panel.querySelectorAll('.emoji-cat-t')].find((x) => x.textContent === name || x.getAttribute('data-cat') === name);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const se = $('emojiSearch'); if (se) { se.oninput = () => renderEmojiPanel(se.value); if (query) { se.focus(); se.selectionStart = se.selectionEnd = query.length; } }
}
function openEmoji(target = 'compose') { emojiTarget = target; const p = $('emojiPanel'); p.classList.remove('hidden'); p.classList.toggle('over-modal', target === 'reactset'); renderEmojiPanel(''); }
function closeEmoji() { $('emojiPanel').classList.add('hidden'); $('emojiPanel').classList.remove('over-modal'); emojiTarget = null; }
function toggleEmoji() { $('emojiPanel').classList.contains('hidden') ? openEmoji('compose') : closeEmoji(); }
$('btnEmoji').onclick = (e) => { e.stopPropagation(); toggleEmoji(); };
document.addEventListener('click', (e) => {
  if ($('emojiPanel').classList.contains('hidden')) return;
  if (e.target.closest('#emojiPanel') || e.target.closest('#btnEmoji')) return;
  closeEmoji();
});

// ── Реакции на постах канала ─────────────────────────────────────────────────
const DEFAULT_RX = ['👍', '❤️', '🔥', '🎉', '😁', '😢', '👏', '🙏'];
let rxTargetC = null, rxTargetM = null;
function renderReactions(d, m, c) {
  if (!m.msgId || m.system) return;
  // Личные чаты: счётчики из «моих» + реакций собеседника; донат 👻 отдельным чипом.
  if (c.type === 'direct') {
    const r = m.reactions; if (!r) return;
    const mine = r.mine || [], theirs = r.theirs || [];
    const counts = {};
    for (const em of mine) counts[em] = (counts[em] || 0) + 1;
    for (const em of theirs) counts[em] = (counts[em] || 0) + 1;
    const bar = document.createElement('div'); bar.className = 'reactions';
    for (const [em, n] of Object.entries(counts)) {
      if (!n) continue;
      const chip = document.createElement('button');
      chip.className = 'rx' + (mine.includes(em) ? ' on' : '');
      chip.innerHTML = `${em}<span class="rx-n">${n}</span>`;
      chip.onclick = (e) => { e.stopPropagation(); reactToggle(c, m, em); };
      bar.appendChild(chip);
    }
    if (r.paid > 0) {
      const pd = document.createElement('button'); pd.className = 'rx paid' + (r.myPaid > 0 ? ' on' : '');
      pd.innerHTML = `👻<span class="rx-n">${r.paid}</span>`; pd.title = t('paid.dmTitle');
      if (!m.mine) pd.onclick = (e) => { e.stopPropagation(); openPaidReactionDirect(c, m); };
      bar.appendChild(pd);
    }
    if (bar.children.length) d.appendChild(bar);
    return;
  }
  const room = c._room || {};
  if (room.reactionsEnabled === false && !room.paidReactionsEnabled) return;
  const rx = m.reactions || { counts: {}, mine: [], paid: 0, myPaid: 0 };
  const bar = document.createElement('div'); bar.className = 'reactions';
  // Показываем ТОЛЬКО уже поставленные реакции (счётчики). Добавление реакции —
  // через ПКМ по сообщению (ряд реакций над меню), как в Telegram. Никакого «+».
  for (const [em, n] of Object.entries(rx.counts || {})) {
    if (!n) continue;
    const chip = document.createElement('button');
    chip.className = 'rx' + ((rx.mine || []).includes(em) ? ' on' : '');
    chip.innerHTML = `${em}<span class="rx-n">${n}</span>`;
    chip.onclick = (e) => { e.stopPropagation(); toggleReactionOn(c, m, em); };
    bar.appendChild(chip);
  }
  // Платная реакция (донат 👻) — счётчик, если уже есть донаты. Клик = донатить ещё.
  if (room.paidReactionsEnabled && rx.paid > 0) {
    const pd = document.createElement('button'); pd.className = 'rx paid' + (rx.myPaid > 0 ? ' on' : '');
    pd.innerHTML = `👻<span class="rx-n">${rx.paid}</span>`;
    pd.title = t('paid.title');
    pd.onclick = (e) => { e.stopPropagation(); openPaidReaction(c, m); };
    bar.appendChild(pd);
  }
  if (bar.children.length) d.appendChild(bar);
}
async function toggleReactionOn(c, m, emoji) {
  try { const sum = await window.prizrak.channelReact({ roomId: c.roomId, msgId: m.msgId, emoji }); m.reactions = sum; if (state.activeId === c.id) renderMessages(); schedulePersist(); }
  catch (e) { alert(t('reaction.failed', { e: e.message })); }
}
// Реакция в личном чате: локально помечаем «свою», шлём собеседнику по E2E.
async function toggleReactionDirect(c, m, emoji) {
  const r = m.reactions || (m.reactions = { mine: [], theirs: [], paid: 0, myPaid: 0 });
  r.mine = r.mine || [];
  const on = !r.mine.includes(emoji);
  if (on) r.mine.push(emoji); else r.mine = r.mine.filter((x) => x !== emoji);
  if (state.activeId === c.id) renderMessages(); schedulePersist();
  try { await window.prizrak.reactDirect({ peerId: c.peerId, msgId: m.msgId, emoji, on }); }
  catch (e) { toast(t('reaction.failed', { e: e.message })); }
}
// Единая точка переключения реакции — маршрутизирует по типу чата.
function reactToggle(c, m, em) { return c.type === 'direct' ? toggleReactionDirect(c, m, em) : toggleReactionOn(c, m, em); }
function addReactionEmoji(em) { if (rxTargetC && rxTargetM) reactToggle(rxTargetC, rxTargetM, em); }
function openReactionPicker(e, c, m) {
  rxTargetC = c; rxTargetM = m;
  const room = c._room || {};
  const emojis = (room.reactionEmojis && room.reactionEmojis.length) ? room.reactionEmojis : DEFAULT_RX;
  document.querySelectorAll('.rx-pop').forEach((x) => x.remove());
  const pop = document.createElement('div'); pop.className = 'rx-pop';
  pop.innerHTML = emojis.map((em) => `<button data-em="${esc(em)}">${em}</button>`).join('') + `<button data-more="1" title="${esc(t('react.more'))}">😀</button>`;
  document.body.appendChild(pop);
  const place = () => { const r = e.target.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 10)) + 'px'; pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px'; };
  place(); requestAnimationFrame(place);
  const close = () => { try { pop.remove(); } catch {} document.removeEventListener('click', onDoc, true); };
  const onDoc = (ev) => { if (!ev.target.closest('.rx-pop')) close(); };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  pop.querySelectorAll('[data-em]').forEach((b) => b.onclick = () => { reactToggle(c, m, b.getAttribute('data-em')); close(); });
  pop.querySelector('[data-more]').onclick = () => { close(); openEmoji('reaction'); };
}
function openPaidReaction(c, m) {
  const room = c._room || {};
  const owner = m.from || room.owner;
  const ov = document.createElement('div'); ov.className = 'modal';
  ov.innerHTML = `<div class="modal-card"><div class="modal-title">${esc(t('paid.title'))}</div>
    <div class="hint">${esc(t('paid.hint', { n: state.balance }))}</div>
    <div class="paid-amt"><button data-a="1" class="primary">1 👻</button><button data-a="5" class="primary">5 👻</button><button data-a="10" class="primary">10 👻</button><button data-a="custom" class="ghost-btn">${esc(t('paid.custom'))}</button></div>
    <div class="row"><button class="ghost-btn pr-no">${esc(t('common.cancel'))}</button></div></div>`;
  document.body.appendChild(ov);
  const done = () => { try { ov.remove(); } catch {} };
  ov.querySelector('.pr-no').onclick = done; ov.onclick = (e) => { if (e.target === ov) done(); };
  ov.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
    const a = b.getAttribute('data-a');
    if (a === 'custom') { done(); openModal(t('paid.customTitle'), t('paid.customHint'), '5', (v) => doPaidReaction(c, m, owner, Number(v))); return; }
    done(); await doPaidReaction(c, m, owner, Number(a));
  });
}
async function doPaidReaction(c, m, owner, amt) {
  if (!(amt > 0)) return;
  try { const sum = await window.prizrak.channelReactPaid({ roomId: c.roomId, msgId: m.msgId, amount: amt, ownerId: owner }); m.reactions = sum; if (state.activeId === c.id) renderMessages(); await refreshWallet(); schedulePersist(); toast(t('paid.sent', { n: amt })); }
  catch (e) { alert(t('paid.failed', { e: e.message })); }
}
// Донат призраков собеседнику как платная реакция в личном чате.
function openPaidReactionDirect(c, m) {
  if (m.mine) return; // на своё сообщение донатить некому
  const ov = document.createElement('div'); ov.className = 'modal';
  ov.innerHTML = `<div class="modal-card"><div class="modal-title">${esc(t('paid.dmTitle'))}</div>
    <div class="hint">${esc(t('paid.dmHint', { n: state.balance, who: (c.title || c.peerId || '').split(':')[0] }))}</div>
    <div class="paid-amt"><button data-a="1" class="primary">1 👻</button><button data-a="5" class="primary">5 👻</button><button data-a="10" class="primary">10 👻</button><button data-a="custom" class="ghost-btn">${esc(t('paid.custom'))}</button></div>
    <div class="row"><button class="ghost-btn pr-no">${esc(t('common.cancel'))}</button></div></div>`;
  document.body.appendChild(ov);
  const done = () => { try { ov.remove(); } catch {} };
  ov.querySelector('.pr-no').onclick = done; ov.onclick = (e) => { if (e.target === ov) done(); };
  ov.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
    const a = b.getAttribute('data-a');
    if (a === 'custom') { done(); openModal(t('paid.customTitle'), t('paid.customHint'), '5', (v) => doPaidReactionDirect(c, m, Number(v))); return; }
    done(); await doPaidReactionDirect(c, m, Number(a));
  });
}
async function doPaidReactionDirect(c, m, amt) {
  if (!(amt > 0)) return;
  const r = m.reactions || (m.reactions = { mine: [], theirs: [], paid: 0, myPaid: 0 });
  try {
    await window.prizrak.reactPaidDirect({ peerId: c.peerId, msgId: m.msgId, amount: amt });
    r.paid = (r.paid || 0) + amt; r.myPaid = (r.myPaid || 0) + amt;
    if (state.activeId === c.id) renderMessages(); await refreshWallet(); schedulePersist();
    toast(t('paid.sent', { n: amt }));
  } catch (e) { alert(t('paid.failed', { e: e.message })); }
}

// ── Создание чатов/групп/каналов ─────────────────────────────────────────────
$('newChat').onclick = () => openModal(t('newchat.title'), t('newchat.hint'), 'bob:example.org', async (v) => {
  if (v.startsWith('prizrak://join/') || v.includes('?join=')) { try { const r = await window.prizrak.joinLink({ link: v }); ensureConv(r.id, { type: r.type, title: r.name, roomId: r.id, avatar: r.avatar }); renderConvList(); selectConv(r.id); } catch (e) { alert(e.message); } return; }
  const peer = normId(v); ensureConv(peer, { type: 'direct', title: peer, peerId: peer }); renderConvList(); selectConv(peer);
});
$('newGroup').onclick = () => openModal(t('newgroup.title'), t('newgroup.hint'), t('newgroup.ph'), async (name) => { const r = await window.prizrak.createGroup({ name }); ensureConv(r.id, { type: 'group', title: r.name, roomId: r.id }); renderConvList(); selectConv(r.id); });
$('newChannel').onclick = () => openModal(t('newchannel.title'), t('newgroup.hint'), t('newchannel.ph'), async (name) => { const r = await window.prizrak.createChannel({ name }); ensureConv(r.id, { type: 'channel', title: r.name, roomId: r.id }); renderConvList(); selectConv(r.id); });

// ── G5: поиск публичных групп по реестру (tech.prizrak.im, через свой сервер) ──
let _gsrchTimer = null;
$('findGroups').onclick = () => { $('gsrchInput').value = ''; $('gsrchList').innerHTML = `<div class="gsrch-empty">${esc(t('gsrch.hint'))}</div>`; $('groupSearchModal').classList.remove('hidden'); setTimeout(() => $('gsrchInput').focus(), 60); };
$('gsrchClose').onclick = () => $('groupSearchModal').classList.add('hidden');
$('gsrchInput').oninput = () => {
  clearTimeout(_gsrchTimer);
  const q = $('gsrchInput').value.trim();
  if (q.length < 2) { $('gsrchList').innerHTML = `<div class="gsrch-empty">${esc(t('gsrch.hint'))}</div>`; return; }
  _gsrchTimer = setTimeout(async () => {
    try {
      const results = await window.prizrak.searchGroups({ q });
      renderGroupSearch(results || []);
    } catch (e) { $('gsrchList').innerHTML = `<div class="gsrch-empty">${esc(t('gsrch.fail', { e: e.message }))}</div>`; }
  }, 300);
};
function renderGroupSearch(results) {
  const box = $('gsrchList'); box.innerHTML = '';
  if (!results.length) { box.innerHTML = `<div class="gsrch-empty">${esc(t('gsrch.empty'))}</div>`; return; }
  for (const r of results) {
    const row = document.createElement('div'); row.className = 'gs-row';
    const already = state.conversations.has(r.roomId);
    row.innerHTML = `<span class="gs-ic">${r.type === 'channel' ? '📢' : '👥'}</span>
      <div class="gs-meta"><div class="gs-name">${esc(r.name || r.roomId)}</div>
      <div class="gs-sub">${esc(r.domain)} · ${esc(t('gsrch.members', { n: r.members || 0 }))}</div>
      ${r.description ? `<div class="gs-desc">${esc(r.description)}</div>` : ''}</div>
      <button class="gs-join ${already ? 'ghost-btn' : 'primary'}">${already ? '✓' : esc(t('gsrch.join'))}</button>`;
    row.querySelector('.gs-join').onclick = async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        const room = await window.prizrak.roomJoin({ roomId: r.roomId });
        ensureConv(room.id, { type: room.type, title: room.name, roomId: room.id, avatar: room.avatar });
        renderConvList(); selectConv(room.id);
        $('groupSearchModal').classList.add('hidden');
        toast(t('gsrch.joined', { n: room.name || room.id }));
      } catch (e) { alert(e.message); btn.disabled = false; }
    };
    box.appendChild(row);
  }
}
$('btnInvite').onclick = () => { const c = state.conversations.get(state.activeId); openModal('Пригласить', 'user:domain', 'carol:example.org', async (raw) => { const userId = normId(raw); try { await window.prizrak.invite({ roomId: c.roomId, userId }); pushMessage(c.id, { system: true, text: `Приглашён: ${userId}` }); } catch (e) { pushMessage(c.id, { system: true, text: 'Ошибка: ' + e.message }); } }); };

// ── Вложения и голосовые ─────────────────────────────────────────────────────
$('btnAttach').onclick = () => { const c = state.conversations.get(state.activeId); if (!c || c.type !== 'direct') return alert('Вложения — в личных чатах'); $('fileInput').click(); };
// Пикер файлов: используем file.path (Electron) — не гоняем большой файл через IPC.
$('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) startUpload({ path: f.path, filename: f.name, mime: f.type }); e.target.value = ''; };

// ── Загрузка файла с прогрессом и отменой (как в Telegram) ───────────────────
const newUploadId = () => 'u' + Math.random().toString(16).slice(2) + Date.now().toString(16);
async function startUpload({ path, bytes, filename, mime }) {
  const c = state.conversations.get(state.activeId);
  if (!c || c.type !== 'direct') { alert('Вложения — в личных чатах'); return; }
  const uploadId = newUploadId();
  const msg = { uploading: true, uploadId, filename: filename || 'файл', percent: 0, mine: true, time: now() };
  c.messages.push(msg); if (c.id === state.activeId) renderMessages();
  let r;
  try { r = await window.prizrak.attachUpload({ uploadId, peerId: c.peerId, path, bytes, filename: msg.filename, mime, voice: false }); }
  catch (e) { r = { error: e.message }; }
  c.messages = c.messages.filter((m) => m !== msg); // убрать прогресс-плашку
  if (r && r.error) pushMessage(c.id, { system: true, text: 'Ошибка вложения: ' + r.error });
  else if (r && r.cancelled) { if (c.id === state.activeId) renderMessages(); }
  else { pushMessage(c.id, { mine: true, attachment: { filename: msg.filename, mime, voice: false, size: r && r.size, ...((r && r.media) || {}) }, time: now(), msgId: r && r.msgId, status: sendStatus(r) }); if (r && r.msgId && r.media) startSenderPush(c, r.msgId, r.media.mediaId); }
  if (c.id === state.activeId) renderMessages();
}
// Отправитель: перенос файла на сервер получателя в фоне + прогресс «Передача получателю X%».
async function startSenderPush(c, msgId, mediaId) {
  const toDom = (c.peerId || '').split(':')[1]; const myDom = (state.me.userId || '').split(':')[1];
  if (!toDom || !myDom || toDom === myDom || !mediaId) return; // локальный чат — переносить некуда
  const m = () => c.messages.find((x) => x.msgId === msgId);
  const mm = m(); if (mm) { mm._txPct = 0; if (c.id === state.activeId) renderMessages(); }
  try { await window.prizrak.mediaFederate({ mediaId, toDomain: toDom }); } catch {}
  for (let i = 0; i < 3600; i++) {
    let s; try { s = await window.prizrak.mediaPushStatus({ mediaId }); } catch {}
    const cur = m(); if (!cur) break;
    if (!s || s.done) { cur._txPct = null; if (c.id === state.activeId) renderMessages(); break; }
    if (s.total) { cur._txPct = Math.min(99, Math.floor((s.sent / s.total) * 100)); if (c.id === state.activeId) renderMessages(); }
    await new Promise((res) => setTimeout(res, 1000));
  }
}
// После перезахода: возобновить опрос прогресса незавершённых передач — сервер
// продолжает переносить файл в фоне, а мы просто снова подтягиваем реальный %.
function resumeTransfers() {
  for (const c of state.conversations.values()) {
    if (c.type !== 'direct') continue;
    for (const m of c.messages) {
      if (m.mine && m._txPct != null && m.attachment && m.attachment.mediaId) resumeSenderPush(c, m.msgId, m.attachment.mediaId);
    }
  }
}
async function resumeSenderPush(c, msgId, mediaId) {
  const m = () => c.messages.find((x) => x.msgId === msgId);
  for (let i = 0; i < 3600; i++) {
    let s; try { s = await window.prizrak.mediaPushStatus({ mediaId }); } catch {}
    const cur = m(); if (!cur) break;
    if (!s || s.done) { cur._txPct = null; if (c.id === state.activeId) renderMessages(); schedulePersist(); break; }
    if (s.total) { cur._txPct = Math.min(99, Math.floor((s.sent / s.total) * 100)); if (c.id === state.activeId) renderMessages(); }
    await new Promise((res) => setTimeout(res, 1000));
  }
}
async function cancelUpload(uploadId) { try { await window.prizrak.attachCancel({ uploadId }); } catch {} }
window.prizrak.onUploadProgress(({ uploadId, percent }) => {
  for (const c of state.conversations.values()) {
    const m = c.messages.find((x) => x.uploading && x.uploadId === uploadId);
    if (m) { m.percent = percent; if (c.id === state.activeId) renderMessages(); break; }
  }
});

// Перетаскивание файлов в область чата. Подсветку (пунктир) включаем по счётчику
// enter/leave — иначе dragleave на дочернем пузыре сообщения не снимал класс, и
// пунктир «залипал» во всех чатах. Плюс страховки: любое завершение перетаскивания
// или уход курсора из окна гарантированно гасят подсветку.
const chatEl = document.querySelector('.chat');
let _dragDepth = 0;
function clearDragOver() { _dragDepth = 0; chatEl.classList.remove('drag-over'); }
chatEl.addEventListener('dragenter', (e) => { e.preventDefault(); _dragDepth++; chatEl.classList.add('drag-over'); });
chatEl.addEventListener('dragover', (e) => { e.preventDefault(); }); // нужно, чтобы сработал drop
chatEl.addEventListener('dragleave', () => { if (--_dragDepth <= 0) clearDragOver(); });
chatEl.addEventListener('drop', (e) => {
  e.preventDefault(); clearDragOver();
  for (const f of [...(e.dataTransfer?.files || [])]) startUpload({ path: f.path, filename: f.name, mime: f.type });
});
// Страховки от «залипшего» пунктира: конец перетаскивания, дроп где угодно,
// уход курсора/фокуса из окна.
window.addEventListener('dragend', clearDragOver);
window.addEventListener('drop', clearDragOver, true);
window.addEventListener('blur', clearDragOver);
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDragOver(); });

// Вставка из буфера: текст — как обычно; картинка — как вложение со скриншот-именем.
document.addEventListener('paste', async (e) => {
  clearDragOver(); // на всякий случай гасим подсветку перетаскивания
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
  if (!img) return; // текст оставляем стандартной вставке в поле
  e.preventDefault();
  const blob = img.getAsFile(); if (!blob) return;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const ext = (img.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const name = `screenshot-${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}-${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}.${ext}`;
  startUpload({ bytes: Array.from(buf), filename: name, mime: img.type });
});
const VWAVE_BARS = 48; // столбиков в «волне» (как в Telegram)
// Считаем амплитудную «волну» из записанного аудио: декодируем, бьём на N сегментов,
// берём RMS каждого сегмента и нормируем в 0..31. Плюс длительность в секундах.
async function computeWave(bytes) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const dur = buf.duration;
    const ch = buf.getChannelData(0);
    const seg = Math.max(1, Math.floor(ch.length / VWAVE_BARS));
    const peaks = []; let max = 1e-6;
    for (let i = 0; i < VWAVE_BARS; i++) {
      let sum = 0; const start = i * seg, end = Math.min(ch.length, start + seg);
      for (let j = start; j < end; j++) sum += ch[j] * ch[j];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      peaks.push(rms); if (rms > max) max = rms;
    }
    const wave = peaks.map((p) => Math.max(1, Math.round((p / max) * 31)));
    try { ctx.close(); } catch {}
    return { dur, wave };
  } catch { return { dur: 0, wave: null }; }
}
let voiceRec = null, voiceChunks = [], voiceStream = null, voiceT0 = 0, voiceTimer = null;
function stopVoiceTimer() { if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; } $('btnVoice').textContent = '🎤'; $('btnVoice').classList.remove('rec'); $('msgInput').placeholder = t('composer.message'); }
$('btnVoice').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type !== 'direct') return alert('Голосовые — в личных чатах');
  if (voiceRec && voiceRec.state === 'recording') { voiceRec.stop(); stopVoiceTimer(); return; }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceRec = new MediaRecorder(voiceStream, { mimeType: 'audio/webm;codecs=opus' }); voiceChunks = [];
    voiceRec.ondataavailable = (ev) => ev.data.size && voiceChunks.push(ev.data);
    voiceRec.onstop = async () => {
      voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null;
      const blob = new Blob(voiceChunks, { type: 'audio/webm' }); const bytes = new Uint8Array(await blob.arrayBuffer());
      const { dur, wave } = await computeWave(bytes);
      const att = { filename: 'voice.webm', mime: 'audio/webm', voice: true, dur, wave };
      const r = await window.prizrak.attachSend({ peerId: c.peerId, bytes: Array.from(bytes), filename: 'voice.webm', mime: 'audio/webm', voice: true, dur, wave });
      Object.assign(att, (r && r.media) || {}); // mediaId/key/nonce → своё голосовое тоже можно переслушать
      pushMessage(c.id, { mine: true, attachment: att, time: now(), msgId: r && r.msgId, status: sendStatus(r) });
    };
    voiceRec.start(); voiceT0 = Date.now();
    $('btnVoice').textContent = '⏹'; $('btnVoice').classList.add('rec');
    voiceTimer = setInterval(() => { const s = Math.floor((Date.now() - voiceT0) / 1000); $('msgInput').placeholder = t('composer.recording', { t: fmtDur(s) }); }, 250);
  } catch (e) { alert(t('mic.noAccess', { e: e.message })); }
};
// ── Голосовые: волна + плеер (как в Telegram) ────────────────────────────────
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function waveFor(m, att) {
  if (att.wave && att.wave.length) return att.wave;
  const seed = String(m.msgId || att.mediaId || 'x'); const out = []; // легаси/без волны — стабильная псевдоволна из id
  for (let i = 0; i < VWAVE_BARS; i++) out.push(4 + (seed.charCodeAt(i % seed.length) * (i + 7)) % 26);
  return out;
}
let vPlay = null; // { msgId, audio, url }
function voiceBarsHtml(wave) { return wave.map((h) => `<span class="vbar" style="height:${Math.max(2, Math.round(h / 31 * 22))}px"></span>`).join(''); }
function renderVoice(d, m, att, c) {
  const wave = waveFor(m, att);
  const playing = vPlay && vPlay.msgId === m.msgId;
  const prog = playing && att.dur ? Math.min(1, (vPlay.audio.currentTime || 0) / att.dur) : 0;
  const checks = m.mine && c.type === 'direct' ? checksHtml(m.status) : '';
  const durTxt = fmtDur(playing ? (vPlay.audio.currentTime || 0) : (att.dur || 0));
  const barsHtml = voiceBarsHtml(wave);
  d.innerHTML = `<div class="voice" data-vmsg="${esc(String(m.msgId || ''))}">
      <button class="vplay">${playing && !vPlay.audio.paused ? '⏸' : '▶'}</button>
      <div class="vbody">
        <div class="vwave"><div class="vbars">${barsHtml}</div><div class="vbars vfill">${barsHtml}</div></div>
        <div class="vmeta"><span class="ic">🎤</span><span class="vdur">${durTxt}</span></div>
      </div>
    </div>
    <div class="time">${m.time || ''}${checks}</div>`;
  const fill = d.querySelector('.vfill'); if (fill) fill.style.clipPath = `inset(0 ${Math.round((1 - prog) * 100)}% 0 0)`;
  d.querySelector('.vplay').onclick = (e) => { e.stopPropagation(); toggleVoice(m, att); };
  d.querySelector('.vwave').onclick = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect(); const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seekVoice(m, att, p);
  };
}
function updateVoiceUI(m, att) {
  const el = document.querySelector(`.voice[data-vmsg="${CSS.escape(String(m.msgId || ''))}"]`); if (!el || !vPlay) return;
  const dur = att.dur || vPlay.audio.duration || 0, cur = vPlay.audio.currentTime || 0;
  const fill = el.querySelector('.vfill'); if (fill) fill.style.clipPath = `inset(0 ${Math.round((1 - (dur ? cur / dur : 0)) * 100)}% 0 0)`;
  const durEl = el.querySelector('.vdur'); if (durEl) durEl.textContent = fmtDur(cur);
  const btn = el.querySelector('.vplay'); if (btn) btn.textContent = vPlay.audio.paused ? '▶' : '⏸';
}
function stopVoice() { if (vPlay) { try { vPlay.audio.pause(); } catch {} try { URL.revokeObjectURL(vPlay.url); } catch {} vPlay = null; } }
async function toggleVoice(m, att) {
  if (vPlay && vPlay.msgId === m.msgId) { if (vPlay.audio.paused) vPlay.audio.play(); else vPlay.audio.pause(); updateVoiceUI(m, att); return; }
  stopVoice();
  try {
    const { bytes } = await window.prizrak.attachFetch({ attachment: att });
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: att.mime || 'audio/webm' }));
    const audio = new Audio(url); vPlay = { msgId: m.msgId, audio, url };
    audio.ontimeupdate = () => updateVoiceUI(m, att);
    audio.onended = () => { stopVoice(); renderMessages(); };
    await audio.play(); renderMessages();
  } catch (e) { alert('Не удалось воспроизвести: ' + e.message); }
}
function seekVoice(m, att, p) {
  if (!(vPlay && vPlay.msgId === m.msgId)) { toggleVoice(m, att).then(() => { if (vPlay && vPlay.audio.duration) { vPlay.audio.currentTime = p * vPlay.audio.duration; updateVoiceUI(m, att); } }); return; }
  if (vPlay.audio.duration) vPlay.audio.currentTime = p * vPlay.audio.duration;
  updateVoiceUI(m, att);
}
async function openAttachment(att) {
  try {
    const { bytes } = await window.prizrak.attachFetch({ attachment: att });
    const blob = new Blob([new Uint8Array(bytes)], { type: att.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    if (att.voice || (att.mime || '').startsWith('audio')) { const a = new Audio(url); a.play(); }
    else { const link = document.createElement('a'); link.href = url; link.download = att.filename || 'file'; link.click(); }
  } catch (e) { alert('Не удалось открыть вложение: ' + e.message); }
}

// ── Звонки на WebCodecs (Opus + VP8), без STUN ───────────────────────────────
// Захват raw-кадров (MediaStreamTrackProcessor) → кодек (VideoEncoder/AudioEncoder)
// → пакеты E2E через stealth-relay → декодер на той стороне → canvas + AudioContext.
// Покадровый контроль: нет контейнера/заголовка (в отличие от MediaRecorder),
// отличное сжатие (Opus ~24-32 кбит/с, VP8 адаптивно) и низкая задержка.
const call = { active: false, media: 'audio', peerId: null, muted: false, started: false,
  stream: null, vEnc: null, aEnc: null, vDec: null, aDec: null,
  vReady: false, aReady: false, waitKey: true, readers: [], keyTimer: null, lastCfgV: null,
  audioCtx: null, playHead: 0 };

const _te = new TextEncoder(), _td = new TextDecoder();
function sendMedia(bytes) { try { if (call.stats) call.stats.sent++; window.prizrak.callMedia({ chunk: Array.from(bytes) }); } catch {} }
function packChunk(kind, chunk) {
  const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
  const out = new Uint8Array(10 + data.length);
  out[0] = kind === 'v' ? 3 : 1;
  out[1] = chunk.type === 'key' ? 1 : 0;
  new DataView(out.buffer).setFloat64(2, chunk.timestamp || 0, true);
  out.set(data, 10);
  return out;
}
function u8ToB64(u) { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
function b64ToU8(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function packConfig(kind, cfg) {
  const c = { codec: cfg.codec };
  if (cfg.codedWidth) { c.codedWidth = cfg.codedWidth; c.codedHeight = cfg.codedHeight; }
  if (cfg.sampleRate) { c.sampleRate = cfg.sampleRate; c.numberOfChannels = cfg.numberOfChannels; }
  if (cfg.description) { const d = cfg.description; const u = d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d); c.description = u8ToB64(u); }
  const json = _te.encode(JSON.stringify(c));
  const out = new Uint8Array(1 + json.length); out[0] = kind === 'v' ? 2 : 0; out.set(json, 1);
  return out;
}

const errStat = (m) => { if (call.stats) call.stats.err = String(m).slice(0, 60); };
async function startEncoders() {
  if (!window.MediaStreamTrackProcessor || !window.AudioEncoder || !window.VideoEncoder) { errStat('WebCodecs/TrackProcessor недоступен'); return; }
  // АУДИО (Opus)
  const atrack = call.stream.getAudioTracks()[0];
  if (atrack) {
    const s = atrack.getSettings();
    call.aEnc = new AudioEncoder({ output: (chunk, meta) => { if (meta?.decoderConfig) sendMedia(packConfig('a', meta.decoderConfig)); sendMedia(packChunk('a', chunk)); }, error: (e) => errStat('aEnc:' + (e.message || e)) });
    try { call.aEnc.configure({ codec: 'opus', sampleRate: s.sampleRate || 48000, numberOfChannels: s.channelCount || 1, bitrate: 32000 }); } catch (e) { errStat('aEncCfg:' + e.message); }
    const rd = new MediaStreamTrackProcessor({ track: atrack }).readable.getReader(); call.readers.push(rd);
    (async () => { while (call.active) { let r; try { r = await rd.read(); } catch { break; } if (r.done) break; try { if (call.aEnc.state === 'configured') call.aEnc.encode(r.value); } catch (e) { errStat('aEnc.enc'); } try { r.value.close(); } catch {} } })();
  }
  // ВИДЕО (VP8)
  const vtrack = call.media === 'video' ? call.stream.getVideoTracks()[0] : null;
  if (vtrack) {
    const s = vtrack.getSettings(); const w = s.width || 640, h = s.height || 480;
    let n = 0; call._forceKey = true;
    call.vEnc = new VideoEncoder({ output: (chunk, meta) => { if (meta?.decoderConfig) call.lastCfgV = packConfig('v', meta.decoderConfig); if (chunk.type === 'key' && call.lastCfgV) sendMedia(call.lastCfgV); sendMedia(packChunk('v', chunk)); }, error: (e) => errStat('vEnc:' + (e.message || e)) });
    try { call.vEnc.configure({ codec: 'vp8', width: w, height: h, bitrate: 1_200_000, framerate: 30, latencyMode: 'realtime' }); }
    catch (e) { try { call.vEnc.configure({ codec: 'vp8', width: w, height: h, bitrate: 1_200_000, framerate: 30 }); } catch (e2) { errStat('vEncCfg:' + e2.message); } }
    const rd = new MediaStreamTrackProcessor({ track: vtrack }).readable.getReader(); call.readers.push(rd);
    (async () => { while (call.active) { let r; try { r = await rd.read(); } catch { break; } if (r.done) break; const frame = r.value; try { if (call.vEnc.state === 'configured' && call.vEnc.encodeQueueSize < 3) { const key = call._forceKey || (n % 60 === 0); call.vEnc.encode(frame, { keyFrame: key }); call._forceKey = false; n++; } } catch (e) { errStat('vEnc.enc'); } try { frame.close(); } catch {} } })();
    call.keyTimer = setInterval(() => { call._forceKey = true; }, 2000); // keyframe для поздних получателей
  }
}
function startRecording() { if (call.started) return; call.started = true; startEncoders(); }

// ── Приём: декодирование + рендер ─────────────────────────────────────────────
function ensureAudioCtx() { if (!call.audioCtx) { call.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); call.playHead = 0; } if (call.audioCtx.state === 'suspended') call.audioCtx.resume().catch(() => {}); return call.audioCtx; }
function playAudio(ad) {
  try {
    if (call.stats) call.stats.aplayed++;
    const ctx = ensureAudioCtx();
    const nb = ad.numberOfFrames, ch = ad.numberOfChannels || 1;
    const buf = ctx.createBuffer(ch, nb, ad.sampleRate);
    for (let c = 0; c < ch; c++) { const arr = new Float32Array(nb); try { ad.copyTo(arr, { planeIndex: c, format: 'f32-planar' }); } catch {} buf.copyToChannel(arr, c); }
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (call.playHead < now + 0.02) call.playHead = now + 0.08; // ресинхронизация при отставании
    src.start(call.playHead); call.playHead += buf.duration;
  } catch {} finally { try { ad.close(); } catch {} }
}
function drawFrame(frame) {
  try { if (call.stats) call.stats.vframes++; const cv = $('remoteCanvas'); const g = cv.getContext('2d'); if (cv.width !== frame.displayWidth) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; } g.drawImage(frame, 0, 0, cv.width, cv.height); } catch {}
  finally { try { frame.close(); } catch {} }
}
function handleMediaPacket(bytes) {
  if (call.stats) call.stats.recv++;
  const t = bytes[0];
  if (t === 0 || t === 2) { // конфиг декодера
    let cfg; try { cfg = JSON.parse(_td.decode(bytes.subarray(1))); } catch { return; }
    if (cfg.description) cfg.description = b64ToU8(cfg.description);
    if (t === 0) { if (!call.aDec) call.aDec = new AudioDecoder({ output: playAudio, error: (e) => errStat('aDec:' + (e.message || e)) }); if (call.aDec.state !== 'configured') { try { call.aDec.configure(cfg); call.aReady = true; } catch (e) { errStat('aDecCfg:' + e.message); } } }
    else { if (!call.vDec) call.vDec = new VideoDecoder({ output: drawFrame, error: (e) => errStat('vDec:' + (e.message || e)) }); if (call.vDec.state !== 'configured') { try { call.vDec.configure(cfg); call.vReady = true; call.waitKey = true; $('remoteCanvas').classList.remove('hidden'); } catch (e) { errStat('vDecCfg:' + e.message); } } }
    return;
  }
  const key = bytes[1] === 1; const ts = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(2, true); const data = bytes.subarray(10);
  if (t === 1) { if (!call.aReady || call.aDec?.state !== 'configured') return; try { call.aDec.decode(new EncodedAudioChunk({ type: key ? 'key' : 'delta', timestamp: ts, data })); } catch {} }
  else if (t === 3) { if (!call.vReady || call.vDec?.state !== 'configured') return; if (call.waitKey) { if (!key) return; call.waitKey = false; } try { call.vDec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data })); } catch {} }
}
window.prizrak.onCallMedia(({ bytes }) => { if (!call.active) return; handleMediaPacket(new Uint8Array(bytes)); });
window.prizrak.onCallRaw(() => { if (call.stats) call.stats.raw++; }); // сырые кадры с relay (до расшифровки)
// Собеседник запросил ключевой кадр (PLI) — выдаём его немедленно (наш энкодер).
window.prizrak.onCallPli(() => { if (call.active) call._forceKey = true; });

async function beginCall(peerId, media, isCaller, offer) {
  call.active = true; call.media = media; call.peerId = peerId; call.muted = false; call.started = false;
  call.vReady = false; call.aReady = false; call.waitKey = true; call.readers = []; call.lastCfgV = null;
  call.stats = { sent: 0, raw: 0, recv: 0, vframes: 0, aplayed: 0, err: '' };
  $('callTitle').textContent = (media === 'video' ? '🎥 Видеозвонок' : '📞 Звонок') + ' · ' + peerId;
  $('callStatus').textContent = isCaller ? t('call.calling') : t('call.connecting');
  $('remoteCanvas').classList.toggle('hidden', media !== 'video');
  $('callPanel').classList.remove('hidden');
  // Живая диагностика: ↑отправлено ↓получено 🎞кадров 🔊аудио ⚠ошибка.
  if (call.statsTimer) clearInterval(call.statsTimer);
  call.statsTimer = setInterval(() => { if (!call.active) return; const s = call.stats; $('callStatus').textContent = `На связи · ↑${s.sent} ↧${s.raw} ↓${s.recv} 🎞${s.vframes} 🔊${s.aplayed}${s.err ? ' · ⚠ ' + s.err : ''}`; }, 700);
  // Пока не получили опорный кадр от собеседника — настойчиво просим ключевой (PLI),
  // иначе видео «чёрное» до планового keyframe. Как только keyframe пришёл — waitKey сброшен.
  if (call.pliTimer) clearInterval(call.pliTimer);
  if (media === 'video') call.pliTimer = setInterval(() => {
    if (!call.active) { clearInterval(call.pliTimer); call.pliTimer = null; return; }
    if (call.waitKey) { try { window.prizrak.callPliRequest(); } catch {} }
  }, 600);
  try {
    ensureAudioCtx(); // разблокировать аудио в рамках жеста (кнопка «Принять/Позвонить»)
    call.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true },
      video: media === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } : false,
    });
    if (isCaller) {
      await window.prizrak.callStart({ peerId, video: media === 'video' });
      // Кодирование начнём по 'answer' (оба плеча relay подключены).
    } else {
      await window.prizrak.callAccept({ peerId, offer });
      $('callStatus').textContent = t('call.connected');
      startRecording();
    }
  } catch (e) { $('callStatus').textContent = t('status.error') + e.message; }
}
function endCall() {
  call.active = false; call.started = false;
  try { if (call.keyTimer) clearInterval(call.keyTimer); } catch {} call.keyTimer = null;
  try { if (call.pliTimer) clearInterval(call.pliTimer); } catch {} call.pliTimer = null;
  try { if (call.statsTimer) clearInterval(call.statsTimer); } catch {} call.statsTimer = null;
  for (const rd of call.readers) { try { rd.cancel(); } catch {} } call.readers = [];
  for (const k of ['vEnc', 'aEnc', 'vDec', 'aDec']) { try { if (call[k] && call[k].state !== 'closed') call[k].close(); } catch {} call[k] = null; }
  try { if (call.audioCtx) call.audioCtx.close(); } catch {} call.audioCtx = null;
  try { call.stream && call.stream.getTracks().forEach((t) => t.stop()); } catch {} call.stream = null;
  $('callPanel').classList.add('hidden');
}
$('btnCall').onclick = () => { const c = state.conversations.get(state.activeId); if (c?.type === 'direct') beginCall(c.peerId, 'audio', true); };
$('btnVideo').onclick = () => { const c = state.conversations.get(state.activeId); if (c?.type === 'direct') beginCall(c.peerId, 'video', true); };
$('btnHangup').onclick = async () => { await window.prizrak.callHangup(); endCall(); };
$('btnMute').onclick = () => { call.muted = !call.muted; if (call.stream) call.stream.getAudioTracks().forEach((t) => (t.enabled = !call.muted)); $('btnMute').textContent = call.muted ? t('call.micMuted') : t('call.muteMic'); };

// Входящий звонок
let pendingOffer = null;
window.prizrak.onIncomingCall(async (ev) => {
  await loadPrivacy();                                   // приватность «Звонки» + чёрный список
  if (!callAllowedFrom(ev.from)) { try { await window.prizrak.callHangup(); } catch {} return; } // молча сбрасываем
  pendingOffer = ev; $('incomingFrom').textContent = `${ev.from} · ${ev.call.media === 'video' ? 'видео' : 'аудио'}`; $('incomingCall').classList.remove('hidden');
});
$('btnAccept').onclick = () => { $('incomingCall').classList.add('hidden'); if (pendingOffer) beginCall(pendingOffer.from, pendingOffer.call.media, false, pendingOffer.call); };
$('btnDecline').onclick = async () => { $('incomingCall').classList.add('hidden'); if (pendingOffer) { try { await window.prizrak.callHangup(); } catch {} pendingOffer = null; } };

// ── События реального времени (пуш) ──────────────────────────────────────────
// Приём вложения: ФАЙЛ показываем и подтверждаем (доставлено/прочитано) ТОЛЬКО
// после того, как он реально лёг на наш сервер. Голосовые — сразу (мелкие).
async function receiveAttachment(convId, ev) {
  const att = ev.attachment; const c = state.conversations.get(convId); if (!c) return;
  if (att.voice) {
    pushMessage(convId, { from: ev.from, attachment: att, time: now(), msgId: ev.msgId });
    if (convId === state.activeId && c.type === 'direct') markPeerRead(c);
    return;
  }
  // Плейсхолдер «получение файла… X%» пока файл переносится на наш сервер.
  const ph = { system: true, text: `📥 Получение файла «${att.filename || 'файл'}»…`, _rx: ev.msgId };
  if (!c.messages.some((m) => m._rx === ev.msgId) && !c.messages.some((m) => m.msgId === ev.msgId)) {
    c.messages.push(ph); if (convId === state.activeId) renderMessages(); renderConvList();
  }
  const size = att.size || 0;
  const maxTries = Math.min(3600, Math.max(60, size ? Math.ceil(size / (100 * 1024)) : 60));
  let present = false;
  for (let i = 0; i < maxTries; i++) {
    let h; try { h = await window.prizrak.mediaHead({ attachment: att }); } catch {}
    if (h && h.present) { present = true; break; }
    if (h && h.total) { const pct = Math.min(99, Math.floor((h.received / h.total) * 100)); ph.text = `📥 Получение файла «${att.filename || 'файл'}»… ${pct}%`; if (convId === state.activeId) renderMessages(); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  c.messages = c.messages.filter((m) => m._rx !== ev.msgId); // убрать плейсхолдер
  if (c.messages.some((m) => m.msgId === ev.msgId)) { if (convId === state.activeId) renderMessages(); return; } // уже добавлено
  pushMessage(convId, { from: ev.from, attachment: att, time: now(), msgId: ev.msgId });
  // Файл у нас — теперь честно подтверждаем доставку (и прочтение, если чат открыт).
  if (present) { try { await window.prizrak.markReceived({ peerId: ev.from, msgIds: [ev.msgId] }); } catch {} }
  if (convId === state.activeId && c.type === 'direct') markPeerRead(c);
}
window.prizrak.onRealtime((ev) => {
  if (ev.kind === 'ready' || ev.kind === 'hs') return; // 'hs' — служебный пинг переустановки сессии
  if (ev.kind === 'receipt') { updateReceipts(ev.from, ev.msgIds, ev.status); return; }
  if (ev.kind === 'delete') { removeMessageEverywhere(ev.msgId); return; }
  if (ev.kind === 'role' || ev.kind === 'owner') return; // роли отражаются при открытии «Участники»
  if (ev.kind === 'room-settings') {
    const c = [...state.conversations.values()].find((x) => x.roomId === ev.roomId);
    if (c && ev.room) { c._room = { ...(c._room || {}), ...ev.room }; refreshComposer(); if (state.activeId === c.id && !$('roomInfoScreen').classList.contains('hidden')) renderRoomInfo(c); }
    return;
  }
  if (ev.kind === 'kicked') {
    const c = [...state.conversations.values()].find((x) => x.roomId === ev.roomId);
    if (c) { state.conversations.delete(c.id); if (state.activeId === c.id) { state.activeId = null; updateChatHeader(null); $('messages').innerHTML = ''; } renderConvList(); schedulePersist(); }
    return;
  }
  if (ev.kind === 'invited') {
    const r = ev.room; if (!r || !r.id) return;
    const existed = state.conversations.has(r.id);
    const c = ensureConv(r.id, { type: r.type, title: r.name, roomId: r.id, avatar: r.avatar });
    if (c) { c.type = r.type; c.title = r.name; c.roomId = r.id; if (r.avatar) c.avatar = r.avatar; if (!existed) c.unread = (c.unread || 0) + 1; }
    renderConvList(); schedulePersist();
    return;
  }
  if (ev.kind === 'ghosts') { refreshWallet(); return; }
  if (ev.kind === 'sync-read') {
    // MD4: чат прочитан на другом моём устройстве → обнуляем непрочитанные и тут.
    const c = ev.peer && state.conversations.get(ev.peer);
    if (c && c.unread) { c.unread = 0; renderConvList(); schedulePersist(); }
    return;
  }
  if (ev.kind === 'sync-sent') {
    // MD3: копия моего исходящего с другого моего устройства → показать как «моё».
    // Личка (ev.peer) или ГРУППА (ev.roomId) — групповые исходящие тоже синхронизируются.
    const inner = ev.inner || {};
    const convId = ev.roomId || ev.peer;
    if (!convId) return;
    const c = ev.roomId
      ? ensureConv(convId, { type: 'group', title: convId.slice(0, 14) + '…', roomId: convId })
      : ensureConv(convId, { type: 'direct', title: convId, peerId: convId });
    if (!c) return;
    const msgId = inner.msgId || null;
    if (msgId && c.messages.some((m) => m.msgId === msgId)) return; // уже есть — дедуп
    if (inner.t === 'att') { const att = { ...inner }; delete att.t; pushMessage(convId, { mine: true, attachment: att, time: now(), msgId }); }
    else if (inner.t === 'gift') pushMessage(convId, { mine: true, gift: { emoji: inner.emoji, name: inner.name, price: inner.price, msg: inner.msg || '', anon: !!inner.anon }, time: now(), msgId });
    else pushMessage(convId, { mine: true, text: inner.body, time: now(), msgId });
    return;
  }
  if (ev.kind === 'reaction') {
    // Реакция собеседника в личном чате (эмодзи-переключение или платный донат).
    const c = state.conversations.get(ev.from); if (!c) return;
    const m = c.messages.find((x) => x.msgId === ev.target); if (!m) return;
    const r = m.reactions || (m.reactions = { mine: [], theirs: [], paid: 0, myPaid: 0 });
    if (ev.paid) { r.paid = (r.paid || 0) + ev.paid; }
    else if (ev.emoji) { r.theirs = r.theirs || []; if (ev.on) { if (!r.theirs.includes(ev.emoji)) r.theirs.push(ev.emoji); } else r.theirs = r.theirs.filter((x) => x !== ev.emoji); }
    if (state.activeId === c.id) renderMessages(); schedulePersist();
    return;
  }
  if (ev.kind === 'channel-reaction') {
    const c = state.conversations.get(ev.roomId); if (!c) return;
    const m = c.messages.find((x) => x.msgId === ev.msgId);
    if (m) { const prev = m.reactions || { mine: [], myPaid: 0 }; m.reactions = { counts: ev.counts || {}, paid: ev.paid || 0, mine: prev.mine || [], myPaid: prev.myPaid || 0 }; if (state.activeId === c.id) renderMessages(); schedulePersist(); }
    return;
  }
  if (ev.kind === 'call') {
    if (ev.call.event === 'offer') return;          // обрабатывается onIncomingCall
    if (ev.call.event === 'answer') { if (call.active) { $('callStatus').textContent = t('call.connected'); startRecording(); } return; }
    if (ev.call.event === 'hangup') { if (call.active) endCall(); return; }
    return;
  }
  const convId = ev.roomId || ev.from;
  if (!state.conversations.has(convId)) {
    if (ev.roomId) ensureConv(convId, { type: 'group', title: ev.roomId.slice(0, 14) + '…', roomId: ev.roomId });
    else ensureConv(convId, { type: 'direct', title: ev.from, peerId: ev.from });
    renderConvList();
  }
  // Счётчик непрочитанных: растёт, если чат не открыт (как в Telegram).
  if (convId !== state.activeId && !ev.error) { const cc0 = state.conversations.get(convId); if (cc0) cc0.unread = (cc0.unread || 0) + 1; }
  if (ev.error) {
    // Нерасшифрованные сообщения (устаревшая сессия после релогина) не спамим —
    // схлопываем подряд идущие в одну спокойную заметку. Соединение при этом
    // само переустанавливается (клиент шлёт handshake), новые сообщения придут.
    const cc = state.conversations.get(convId);
    const last = cc && cc.messages[cc.messages.length - 1];
    if (last && last.decodeErr) { last.count = (last.count || 1) + 1; last.text = t('decode.many', { n: last.count }); if (convId === state.activeId) renderMessages(); }
    else pushMessage(convId, { system: true, decodeErr: true, count: 1, text: t('decode.one') });
  }
  else if (ev.kind === 'attachment') { receiveAttachment(convId, ev); }
  else if (ev.kind === 'gift') { pushMessage(convId, { from: ev.from, gift: ev.gift, time: now(), ts: Date.now(), msgId: ev.msgId }); }
  else pushMessage(convId, { from: ev.from, text: ev.text, preview: ev.preview || null, time: now(), msgId: ev.msgId });
  // «Oh-oh!» на входящее — но не для чатов «без звука» (мьют по пользователю).
  if (!ev.error) { const cc = state.conversations.get(convId); if (!cc || !isChatMuted(cc)) playIncomingSound(); }
  // Если чат открыт — сразу помечаем прочитанным (собеседник увидит синие галочки).
  if (convId === state.activeId && !ev.error) { const cc = state.conversations.get(convId); if (cc && cc.type === 'direct') markPeerRead(cc); }
});

// ── 🎁 Магазин подарков (как в Telegram, оплата 👻) ──────────────────────────
let _giftSel = null;
let _giftRecipient = null;   // {peerId, title, convId} — кому отправляем подарок
$('btnGiftShop').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type !== 'direct') return;
  openGiftShopFor(c.peerId, c.title || c.peerId, c.id);
};
// Открыть магазин подарков для произвольного получателя (из чата или из настроек).
async function openGiftShopFor(peerId, title, convId) {
  if (!peerId) return;
  _giftRecipient = { peerId, title: title || peerId, convId: convId || null };
  _giftSel = null;
  $('gsRecipient').textContent = '→ ' + (title || peerId);
  $('giftGrid').innerHTML = `<div class="gsrch-empty">${esc(t('common.loading'))}</div>`;
  $('giftSendBox').classList.add('hidden'); $('giftMsg').value = ''; $('giftAnon').checked = false;
  $('giftSendBtn').disabled = true; $('giftSendBtn').textContent = t('gift.send');
  $('giftShopModal').classList.remove('hidden');
  try {
    const [cat, bal] = await Promise.all([window.prizrak.giftCatalog(), refreshWallet().then(() => state.balance).catch(() => null)]);
    $('giftBalance').textContent = bal != null ? t('gift.balance', { n: bal }) : '';
    renderGiftGrid(cat.gifts || []);
  } catch (e) { $('giftGrid').innerHTML = `<div class="gsrch-empty">${esc(e.message)}</div>`; }
}
// «Отправить подарок» из настроек: выбрать получателя из личных чатов, затем магазин.
function pickGiftRecipient() {
  const dms = [...state.conversations.values()].filter((c) => c.type === 'direct' && c.peerId);
  if (!dms.length) { toast(t('gift.noPeers')); return; }
  const list = dms.map((c) => `${c.title || c.peerId} (${c.peerId})`).join('\n');
  openModal(t('gift.shop'), t('gift.pickHint') + '\n' + list, dms[0].peerId, (raw) => {
    const v = (raw || '').trim(); if (!v) return;
    const found = dms.find((c) => c.peerId === v || (c.title || '') === v) || dms.find((c) => c.peerId.startsWith(v));
    const peerId = found ? found.peerId : v;
    const title = found ? (found.title || found.peerId) : v;
    const convId = found ? found.id : null;
    openGiftShopFor(peerId, title, convId);
  });
}
function renderGiftGrid(gifts) {
  const box = $('giftGrid'); box.innerHTML = '';
  if (!gifts.length) { box.innerHTML = `<div class="gsrch-empty">${esc(t('gift.empty'))}</div>`; return; }
  for (const g of gifts) {
    const sold = g.left === 0;
    const el = document.createElement('div');
    el.className = 'gift-card' + (sold ? ' sold' : '');
    el.innerHTML = `<div class="gift-em">${esc(g.emoji)}</div><div class="gift-nm">${esc(g.name)}</div><div class="gift-pr">${g.price} 👻</div>${g.left != null ? `<div class="gift-left">${sold ? esc(t('gift.soldOut')) : esc(t('gift.left', { n: g.left }))}</div>` : ''}`;
    if (!sold) el.onclick = () => {
      _giftSel = g;
      box.querySelectorAll('.gift-card').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      $('giftSendBox').classList.remove('hidden');
      $('giftSendBtn').disabled = false;
      $('giftSendBtn').textContent = `${t('gift.send')} · ${g.price} 👻`;
    };
    box.appendChild(el);
  }
}
$('giftCancel').onclick = () => $('giftShopModal').classList.add('hidden');
$('giftSendBtn').onclick = async () => {
  if (!_giftRecipient || !_giftSel) return;
  const to = _giftRecipient.peerId;
  $('giftSendBtn').disabled = true;
  try {
    const msg = $('giftMsg').value.trim(), anon = $('giftAnon').checked;
    const r = await window.prizrak.giftSend({ to, giftId: _giftSel.id, msg, anon });
    // Локально показать отправленный подарок в переписке, если она открыта/существует.
    const conv = _giftRecipient.convId || [...state.conversations.values()].find((c) => c.type === 'direct' && c.peerId === to)?.id;
    if (conv) pushMessage(conv, { mine: true, gift: { emoji: _giftSel.emoji, name: _giftSel.name, price: _giftSel.price, msg, anon }, time: now(), ts: Date.now(), msgId: r.msgId });
    $('giftShopModal').classList.add('hidden');
    toast(t('gift.sent')); refreshWallet();
  } catch (e) { alert(e.message); $('giftSendBtn').disabled = false; }
};

// ── 🎁 Просмотр подарка: кто отправил + анимация призраков ────────────────────
function openGiftInfo(m, c) {
  const g = m.gift || {};
  const peer = c ? (c.title || c.peerId || '') : '';
  const sender = m.mine ? t('gift.you') : (g.anon ? t('gift.anonName') : (peer || t('gift.anonName')));
  let dateStr = '';
  try {
    if (m.ts) {
      // Коротко: число + время (напр. «22.08.2026, 15:55»).
      const d = new Date(m.ts), loc = state.lang === 'en' ? 'en-US' : 'ru-RU';
      dateStr = d.toLocaleDateString(loc) + ', ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    } else if (m.time) dateStr = String(m.time); // у старых сообщений даты нет — только время
  } catch (e) { dateStr = String(m.time || ''); }
  const stage = $('giftInfoStage');
  // 7 призраков, летающих по эллипсам вокруг подарка (аналог звёзд в Telegram).
  // У каждого своя случайная скорость: 20–100% от максимальной (база класса = 100%).
  const GF_BASE = [7.5, 9, 8, 9.5, 7, 10, 8.5]; // базовые секунды на круг из CSS (.gf0–.gf6)
  let ghosts = '';
  for (let i = 0; i < 7; i++) {
    const spd = 0.2 + Math.random() * 0.8;
    ghosts += `<span class="ghost-fly gf${i}" style="animation-duration:${(GF_BASE[i] / spd).toFixed(1)}s">👻</span>`;
  }
  stage.innerHTML = ghosts + `<span class="gift-center">${esc(g.emoji || '🎁')}</span>`;
  // Перезапуск анимации всплытия подарка.
  const center = stage.querySelector('.gift-center');
  center.style.animation = 'none'; void center.offsetWidth; center.style.animation = '';
  $('giftInfoName').textContent = g.name || t('gift.info');
  const rows = [];
  // «Кому» не показываем — и так понятно; «От кого» — только для не-анонимных входящих.
  if (!m.mine && !g.anon) rows.push([t('gift.sender'), sender]);
  if (g.msg) rows.push(['«' + g.msg + '»', '', 'msg']);
  rows.push([t('gift.price'), (Number(g.price) || 0) + ' 👻']);
  if (dateStr) rows.push([t('gift.date'), dateStr]);
  $('giftInfoRows').innerHTML = rows.map((r) => r[2] === 'msg'
    ? `<div class="gi-msg">${esc(r[0])}</div>`
    : `<div class="gi-row"><span class="gi-lbl">${esc(r[0])}</span><span class="gi-val">${esc(r[1])}</span></div>`).join('');
  $('giftInfoModal').classList.remove('hidden');
}
if ($('giftInfoClose')) $('giftInfoClose').onclick = () => $('giftInfoModal').classList.add('hidden');
if ($('giftInfoModal')) $('giftInfoModal').onclick = (e) => { if (e.target === $('giftInfoModal')) $('giftInfoModal').classList.add('hidden'); };

// «Мои подарки»: список с распылением и скрытием.
$('setMyGifts').onclick = async () => {
  $('myGiftsList').innerHTML = `<div class="gsrch-empty">${esc(t('common.loading'))}</div>`;
  $('myGiftsModal').classList.remove('hidden');
  try {
    const d = await window.prizrak.giftsMine();
    renderMyGifts(d.gifts || [], d.convertPct || 50);
  } catch (e) { $('myGiftsList').innerHTML = `<div class="gsrch-empty">${esc(e.message)}</div>`; }
};
function renderMyGifts(gifts, pct) {
  const box = $('myGiftsList'); box.innerHTML = '';
  if (!gifts.length) { box.innerHTML = `<div class="gsrch-empty">${esc(t('gift.empty'))}</div>`; return; }
  for (const g of gifts) {
    const back = Math.floor((g.price * pct) / 100);
    const from = g.anon ? t('gift.fromAnon') : t('gift.from', { n: g.from || '?' });
    const row = document.createElement('div');
    row.className = 'mg-row';
    row.innerHTML = `<span class="mg-em">${esc(g.emoji)}</span><div class="mg-meta"><div>${esc(g.name)} · ${g.price} 👻</div><div class="mg-sub">${esc(from)}${g.msg ? ' · «' + esc(g.msg) + '»' : ''}${g.hidden ? ' · скрыт' : ''}</div></div>
      <button data-h="1" class="ghost-btn">${g.hidden ? esc(t('gift.show')) : esc(t('gift.hide'))}</button>
      <button data-c="1" class="danger">${esc(t('gift.convert', { n: back }))}</button>`;
    row.querySelector('[data-h]').onclick = async () => { try { await window.prizrak.giftHide({ id: g.id, hidden: !g.hidden }); $('setMyGifts').onclick(); } catch (e) { alert(e.message); } };
    row.querySelector('[data-c]').onclick = async () => {
      if (!(await confirmAsk(`Распылить ${g.emoji} ${g.name} за ${back} 👻? Подарок исчезнет.`))) return;
      try { const r = await window.prizrak.giftConvert({ id: g.id }); toast(t('gift.converted', { n: r.ghosts })); refreshWallet(); $('setMyGifts').onclick(); } catch (e) { alert(e.message); }
    };
    box.appendChild(row);
  }
}
$('myGiftsClose').onclick = () => $('myGiftsModal').classList.add('hidden');

// ── Выход ────────────────────────────────────────────────────────────────────
$('btnLogout').onclick = async () => { await window.prizrak.logout(); location.reload(); };

// ── Ретеншн комнаты (кламп к админскому на сервере) ──────────────────────────
const RET = 'forever,1y,6mo,3mo,1mo,2w,1w,3d,1d';
$('btnRetention').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type === 'direct') return;
  openModal('Срок хранения истории', `Допустимо: ${RET}. Больше админского лимита нельзя.`, '3mo', async (v) => {
    try { const r = await window.prizrak.roomRetention({ roomId: c.roomId, retention: v });
      pushMessage(c.id, { system: true, text: r.clamped ? `Срок склампан к админскому: ${r.effective}` : `Срок хранения: ${r.effective}` }); }
    catch (e) { pushMessage(c.id, { system: true, text: 'Ошибка: ' + e.message }); }
  });
};

// ── Админ: настройки хранилища/ретеншна ─────────────────────────────────────
$('btnAdmin').onclick = async () => {
  let s; try { s = await window.prizrak.adminStorageGet(); } catch (e) { return alert(e.message); }
  const used = (s.storage.usedBytes / 1048576).toFixed(1), max = (s.storage.maxBytes / 1048576).toFixed(0);
  openModal('Настройки сервера (админ)',
    `Ретеншн: ${s.retention} · использовано ${used}МБ из ${max}МБ · путей: ${s.storage.paths.length}.\n` +
    `Введите команду: retention=<срок> | addpath=/путь | max=<МБ>`,
    'retention=6mo', async (v) => {
      const opts = {};
      if (v.startsWith('retention=')) opts.retention = v.slice(10).trim();
      else if (v.startsWith('addpath=')) opts.addPath = v.slice(8).trim();
      else if (v.startsWith('max=')) opts.maxBytes = Number(v.slice(4).trim()) * 1048576;
      try { const r = await window.prizrak.adminStorageSet(opts); alert(`Готово. Ретеншн: ${r.retention}, путей: ${r.storage.paths.length}, лимит ${(r.storage.maxBytes/1048576).toFixed(0)}МБ`); }
      catch (e) { alert(e.message); }
    });
};

// ── Профили и аватары ────────────────────────────────────────────────────────
function avatarUrl(a) { return a && a.data ? `data:${a.mime || 'image/png'};base64,${a.data}` : ''; }
function fileToAvatar(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const m = /^data:(.+?);base64,(.*)$/.exec(r.result); if (!m) return rej(new Error('плохой файл')); res({ mime: m[1], data: m[2] }); }; r.onerror = rej; r.readAsDataURL(file); }); }
const AVA_MAX = 700000;
let pfAvatar = null, rmAvatar = null, rmRoomId = null;

$('btnMyProfile').onclick = async () => {
  let p = {}; try { p = await window.prizrak.getProfile({ userId: state.me.userId }); } catch {}
  $('pfName').value = p.displayName && p.displayName !== state.me.userId.split(':')[0] ? p.displayName : '';
  $('pfBio').value = p.bio || ''; $('pfBirthday').value = p.birthday || ''; $('pfPhone').value = p.phone || '';
  $('pfShowPhone').checked = !!p.phone; $('pfChannel').value = p.personalChannel || '';
  pfAvatar = p.avatar || null; $('pfAvatarPrev').src = avatarUrl(pfAvatar);
  $('profileModal').classList.remove('hidden');
};
$('pfAvatarBtn').onclick = () => $('pfAvatarFile').click();
$('pfAvatarFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const a = await fileToAvatar(f); if (a.data.length > AVA_MAX) return alert('Аватар слишком большой (~512КБ макс)'); pfAvatar = a; $('pfAvatarPrev').src = avatarUrl(pfAvatar); e.target.value = ''; };
$('pfCancel').onclick = () => $('profileModal').classList.add('hidden');
$('pfShare').onclick = async () => {
  try {
    const sh = await window.prizrak.contactShare({ userId: state.me.userId });
    try { await navigator.clipboard.writeText(sh.link); } catch {}
    alert('Ваша ссылка-визитка скопирована:\n\n' + sh.link + '\n\nОтправьте её кому угодно — по клику откроется Prizrak и начнётся чат с вами.\nПрямая схема: ' + sh.deepLink);
  } catch (e) { alert(e.message); }
};
$('pfSave').onclick = async () => {
  const fields = { displayName: $('pfName').value.trim(), bio: $('pfBio').value.trim(), birthday: $('pfBirthday').value, phone: $('pfPhone').value.trim(), showPhone: $('pfShowPhone').checked, personalChannel: $('pfChannel').value.trim() };
  if (pfAvatar) fields.avatar = pfAvatar;
  try { await window.prizrak.setProfile({ fields }); $('profileModal').classList.add('hidden'); } catch (e) { alert(e.message); }
};

// ── Экран редактирования канала/группы (как «Изм.» в Telegram) ──────────────
async function openRoomEdit() {
  const c = state.conversations.get(state.activeId); if (!c || c.type === 'direct') return; rmRoomId = c.roomId;
  let room = { name: c.title, description: '', avatar: c.avatar };
  try { room = (await window.prizrak.listRooms()).find((x) => x.id === c.roomId) || room; } catch {}
  if (!room || !room.id) { try { const r = await window.prizrak.roomGet({ roomId: c.roomId }); if (r && r.id) room = r; } catch {} } // комната на чужом сервере
  c._room = room;
  const isCh = c.type === 'channel';
  $('reName').value = room.name || ''; $('reDesc').value = room.description || ''; rmAvatar = room.avatar || null;
  $('reAvatarPrev').src = avatarUrl(rmAvatar); $('reAvatarPrev').classList.toggle('hidden', !rmAvatar);
  $('reReactRow').classList.remove('hidden'); // реакции — и в каналах, и в группах
  $('reReactVal').textContent = room.reactionsEnabled !== false ? t('common.on') : t('common.off');
  $('reDeleteLbl').textContent = isCh ? t('room.deleteChannel') : t('room.deleteGroup');
  resolveInviteLink(c);
  $('roomEditScreen').classList.remove('hidden');
}
// Ссылка-приглашение: берём ВНЕШНЮЮ веб-ссылку (prizrak.paymoney.online/?join=…) —
// её можно отправить куда угодно, браузер перебросит в приложение (prizrak://join/…).
// Домен позже сменим на prizrak.im. Если сервер недоступен — запасной deep-link.
async function resolveInviteLink(c) {
  try { const s = await window.prizrak.roomShare({ roomId: c.roomId }); c._inviteLink = s.link || s.deepLink || `prizrak://join/${c.roomId}`; }
  catch { c._inviteLink = `prizrak://join/${c.roomId}`; }
  return c._inviteLink;
}
$('btnRoomEdit').onclick = openRoomEdit;
$('reBack').onclick = () => $('roomEditScreen').classList.add('hidden');
$('reAvatarBtn').onclick = () => $('reAvatarFile').click();
$('reAvatarFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const a = await fileToAvatar(f); if (a.data.length > AVA_MAX) return alert(t('avatar.tooBig')); rmAvatar = a; $('reAvatarPrev').src = avatarUrl(rmAvatar); $('reAvatarPrev').classList.remove('hidden'); e.target.value = ''; };
$('reSave').onclick = async () => {
  const fields = { name: $('reName').value.trim(), description: $('reDesc').value.trim() }; if (rmAvatar) fields.avatar = rmAvatar;
  try {
    const r = await window.prizrak.setRoomProfile({ roomId: rmRoomId, fields });
    const c = state.conversations.get(rmRoomId);
    if (c) { c.title = r.name; c.avatar = r.avatar; if (state.activeId === c.id) { updateChatHeader(c); renderMessages(); } }
    renderConvList(); schedulePersist(); $('roomEditScreen').classList.add('hidden');
  } catch (e) { alert(e.message); }
};
$('reLinkRow').onclick = async () => {
  const c = state.conversations.get(rmRoomId); if (!c) return;
  const link = await resolveInviteLink(c); try { await navigator.clipboard.writeText(link); } catch {} toast(t('toast.linkCopied'));
};
$('reMembersRow').onclick = () => $('btnMembers').onclick();
$('reReactRow').onclick = () => openReactModal();
$('reDiagRow').onclick = () => openDiag();
// ── Диагностика доставки канала/группы ───────────────────────────────────────
async function openDiag() {
  // «Раздать ключи заново» имеет смысл только для КАНАЛОВ (общий ключ эпохи на сервере).
  // В группах/личке общего ключа нет (E2E попарно), раздавать нечего — прячем кнопку,
  // чтобы не пугать ошибкой not-channel.
  const _c = state.conversations.get(state.activeId);
  $('diagFix').classList.toggle('hidden', !(_c && _c.type === 'channel'));
  $('diagList').innerHTML = `<div class="hint" style="padding:12px">${esc(t('common.loading'))}</div>`;
  $('diagModal').classList.remove('hidden');
  try {
    const d = await window.prizrak.roomDiag({ roomId: rmRoomId });
    renderDiag(d);
  } catch (e) { $('diagList').innerHTML = `<div class="hint" style="padding:12px">${esc(e.message)}</div>`; }
}
function renderDiag(d) {
  const box = $('diagList'); box.innerHTML = '';
  const rows = (d && d.report) || [];
  if (!rows.length) { box.innerHTML = `<div class="hint" style="padding:12px">—</div>`; return; }
  for (const r of rows) {
    const ok = r.reachable;
    const div = document.createElement('div'); div.className = 'diag-row' + (ok ? ' ok' : ' bad');
    const keyNote = r.hasKey === true ? ` · ${t('diag.haskey')}` : (r.hasKey === false ? ` · ${t('diag.nokey')}` : '');
    const status = ok ? (t('diag.ok') + keyNote) : (r.reason || 'недоступен');
    div.innerHTML = `<span class="diag-ic">${ok ? '✅' : '⛔'}</span><div class="diag-meta"><div class="diag-u">${esc(r.user)}</div><div class="diag-s">${esc(status)}</div></div>`;
    box.appendChild(div);
  }
}
$('diagFix').onclick = async () => {
  $('diagFix').disabled = true;
  try {
    const r = await window.prizrak.channelResync({ roomId: rmRoomId });
    if (r && r.error) throw new Error(r.error);
    if (r && r.ok === false) { toast(r.reason === 'no-rights' ? t('diag.noRights') : t('diag.fixFail', { e: r.reason || '—' })); }
    else { const n = (r && r.granted) || 0; toast(n > 0 ? t('diag.granted', { n }) + (r && r.rotated ? ' ' + t('diag.rotated') : '') : t('diag.nothing')); }
    await openDiag();
  } catch (e) { alert(t('diag.fixFail', { e: e.message })); }
  finally { $('diagFix').disabled = false; }
};
$('diagClose').onclick = $('diagClose2').onclick = () => $('diagModal').classList.add('hidden');
$('reDelete').onclick = async () => {
  const c = state.conversations.get(rmRoomId); if (!c) return;
  if (!(await confirmAsk(t('room.deleteAsk', { name: c.title })))) return;
  try { await window.prizrak.roomLeave({ roomId: c.roomId }); } catch {}
  state.conversations.delete(c.id); if (state.activeId === c.id) { state.activeId = null; updateChatHeader(null); $('messages').innerHTML = ''; }
  $('roomEditScreen').classList.add('hidden'); renderConvList(); schedulePersist();
};

// ── Модалка «Реакции» (как в Telegram, скрин 4) ─────────────────────────────
let reactEmojiList = [];
function renderReactEmojis() {
  const box = $('reactEmojis'); box.innerHTML = '';
  for (const em of reactEmojiList) {
    const b = document.createElement('button'); b.className = 'react-em'; b.textContent = em; b.title = em;
    b.onclick = () => { reactEmojiList = reactEmojiList.filter((x) => x !== em); renderReactEmojis(); };
    box.appendChild(b);
  }
}
function renderReactTicks() { const box = $('reactTicks'); box.innerHTML = ''; for (let i = 1; i <= 11; i++) { const s = document.createElement('span'); s.textContent = i; box.appendChild(s); } }
function reactAddEmoji(em) { if (!reactEmojiList.includes(em)) { reactEmojiList.push(em); renderReactEmojis(); } }
function openReactModal() {
  const c = state.conversations.get(rmRoomId); const room = (c && c._room) || {};
  $('reactOn').checked = room.reactionsEnabled !== false;
  $('reactPaid').checked = !!room.paidReactionsEnabled;
  $('reactMax').value = room.maxReactions || 11;
  reactEmojiList = (room.reactionEmojis && room.reactionEmojis.length) ? [...room.reactionEmojis] : [...DEFAULT_RX];
  renderReactEmojis(); renderReactTicks();
  $('reactBody').classList.toggle('off', !$('reactOn').checked);
  $('reactModal').classList.remove('hidden');
}
$('reactClose').onclick = () => $('reactModal').classList.add('hidden');
$('reactOn').onchange = () => $('reactBody').classList.toggle('off', !$('reactOn').checked);
$('reactAdd').onclick = (e) => { e.stopPropagation(); openEmoji('reactset'); };
$('reactSave').onclick = async () => {
  const c = state.conversations.get(rmRoomId); if (!c) return;
  try {
    const rm = await window.prizrak.roomReactionsSettings({ roomId: rmRoomId, reactionsEnabled: $('reactOn').checked, paidReactionsEnabled: $('reactPaid').checked, reactionEmojis: reactEmojiList, maxReactions: Number($('reactMax').value) });
    c._room = rm; if (state.activeId === c.id) renderMessages();
    $('reReactVal').textContent = rm.reactionsEnabled ? t('common.on') : t('common.off');
    toast(t('common.done')); $('reactModal').classList.add('hidden');
  } catch (e) { alert(e.message); }
};

$('btnShare').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type === 'direct') return;
  const link = await resolveInviteLink(c); try { await navigator.clipboard.writeText(link); } catch {}
  pushMessage(c.id, { system: true, text: t('share.hint', { link }) });
};

let viewPeer = null;
$('btnViewProfile').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type !== 'direct') return;
  viewPeer = c.peerId;
  let p = {}; try { p = await window.prizrak.getProfile({ userId: c.peerId }); } catch (e) { return alert(e.message); }
  $('vwAvatar').src = avatarUrl(p.avatar); $('vwName').textContent = p.displayName || c.peerId; $('vwId').textContent = c.peerId;
  $('vwBio').textContent = p.bio || ''; $('vwBirthday').textContent = p.birthday ? '🎂 ' + p.birthday : '';
  $('vwPhone').textContent = p.phone ? '📞 ' + p.phone : ''; $('vwChannel').textContent = p.personalChannel ? '📢 ' + p.personalChannel : '';
  await renderSafety(c.peerId);
  // 🎁 Витрина подарков собеседника (публичная, из Банка).
  $('vwGiftsBlock').classList.add('hidden'); $('vwGifts').innerHTML = '';
  window.prizrak.giftsOf({ userId: c.peerId }).then((gifts) => {
    if (!gifts || !gifts.length || viewPeer !== c.peerId) return;
    $('vwGifts').innerHTML = gifts.slice(0, 24).map((g) => `<span class="gift-shelf-item" title="${esc(g.name)}${g.from ? ' · ' + esc(g.from) : ''}">${esc(g.emoji)}</span>`).join('');
    $('vwGiftsBlock').classList.remove('hidden');
  }).catch(() => {});
  $('viewModal').classList.remove('hidden');
};
async function renderSafety(peerId) {
  try {
    const s = await window.prizrak.safetyStatus({ userId: peerId });
    $('vwSafety').textContent = (s.fingerprint || '').replace(/(.{4})/g, '$1 ').trim();
    const st = $('vwStatus'); st.className = 'vstatus ' + s.status;
    st.textContent = s.status === 'verified' ? '✓ проверен' : s.status === 'changed' ? '⚠ ключ изменился!' : 'не проверен';
    $('vwVerify').textContent = s.status === 'verified' ? 'Снять отметку' : 'Отметить проверенным';
    const c = [...state.conversations.values()].find((x) => x.peerId === peerId); if (c) c.verified = s.status === 'verified';
    renderConvList();
    const qr = await window.prizrak.safetyQr({ text: `prizrak-verify:${peerId}:${s.fingerprint}` });
    if (qr.dataUrl) { $('vwQr').src = qr.dataUrl; $('vwQr').classList.remove('hidden'); } else $('vwQr').classList.add('hidden');
  } catch (e) { $('vwSafety').textContent = t('status.keyUnavail') + e.message; $('vwQr').classList.add('hidden'); }
}
$('vwVerify').onclick = async () => {
  if (!viewPeer) return;
  try { const s = await window.prizrak.safetyStatus({ userId: viewPeer });
    if (s.status === 'verified') await window.prizrak.safetyUnverify({ userId: viewPeer }); else await window.prizrak.safetyVerify({ userId: viewPeer });
    await renderSafety(viewPeer);
  } catch (e) { alert(e.message); }
};
$('vwShare').onclick = async () => {
  if (!viewPeer) return;
  try { const sh = await window.prizrak.contactShare({ userId: viewPeer }); try { await navigator.clipboard.writeText(sh.link); } catch {} alert('Ссылка на контакт скопирована:\n' + sh.link); }
  catch (e) { alert(e.message); }
};
$('vwClose').onclick = () => $('viewModal').classList.add('hidden');

// ── Удаление выбранных сообщений ─────────────────────────────────────────────
$('btnDelSel').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  const msgs = c.messages.filter((m) => m.msgId && state.selected.has(m.msgId));
  openDeleteModal(msgs, c); // модалка «у меня / у всех»
};

// ── Участники и роли ─────────────────────────────────────────────────────────
$('btnMembers').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c || c.type === 'direct') return;
  // listRooms отдаёт только НАШИ локальные комнаты; группа может жить на чужом
  // сервере (федерация) — тогда добираем её через roomGet.
  let room; try { room = (await window.prizrak.listRooms()).find((x) => x.id === c.roomId); } catch {}
  if (!room) { try { room = await window.prizrak.roomGet({ roomId: c.roomId }); } catch {} }
  if (!room || !room.id) return alert(t('members.loadFail'));
  const n = roomParticipants(room);
  const title = room.type === 'channel' ? (n === 1 ? t('members.subs.one', { n }) : t('members.subs.many', { n })) : (n === 1 ? t('members.count.one', { n }) : t('members.count.many', { n }));
  $('mbTitle').textContent = title;
  renderMembers(room); $('membersModal').classList.remove('hidden');
};
$('mbClose').onclick = () => $('membersModal').classList.add('hidden');

// ── Экран «Информация о канале/группе» (как в Telegram) ──────────────────────
function openRoomInfo(c) {
  if (!c || c.type === 'direct') return;
  renderRoomInfo(c);
  $('roomInfoScreen').classList.remove('hidden');
  if (!c._room) loadRoomInfo(c); // догрузим состав и перерисуем
}
function renderRoomInfo(c) {
  const room = c._room || {};
  const isCh = c.type === 'channel';
  const av = c.avatar ? `<img src="${avatarUrl(c.avatar)}" alt="">` : (isCh ? '📢' : '👥');
  $('riAva').innerHTML = av;
  $('riName').textContent = c.title || (isCh ? t('word.channel') : t('word.group'));
  const cnt = room.id ? roomParticipants(room) : null;
  $('riSub').textContent = (isCh ? t('word.channel') : t('word.group')) + (cnt != null ? ` · ${isCh ? t('presence.subs', { n: cnt }) : t('presence.membersN', { n: cnt })}` : '');
  const desc = room.description || c.description || '';
  $('riInfoBlock').classList.toggle('hidden', !desc);
  $('riDesc').textContent = desc;
  // Ссылка-приглашение (deep link) — покажем и дадим скопировать.
  const link = c._inviteLink || '';
  $('riLinkBlock').classList.toggle('hidden', !link);
  $('riLink').textContent = link;
  $('riRowLink').classList.toggle('hidden', !link);
  // Уведомления вкл/выкл.
  $('riMuteLbl').textContent = isChatMuted(c) ? t('info.muteOn') : t('info.notif');
  // Участники — счётчик значением в строке.
  $('riValMembers').textContent = cnt != null ? String(cnt) : '';
  // Управление вступлением/выходом.
  const member = isRoomMember(room);
  const iManage = room.owner === state.me.userId || (room.admins || []).includes(state.me.userId);
  $('riJoin').classList.toggle('hidden', !room.id || member);
  $('riLeave').classList.toggle('hidden', !room.id || !member);
  $('riLeave').textContent = isCh ? t('info.leaveCh') : t('info.leaveGr');
  $('riAdd').style.display = iManage || !isCh ? '' : 'none'; // добавлять в канал — только админам
  // Управление группой (владелец/админ группы): строки Тип/Разрешения/Автоудаление/История.
  const showManage = room.id && !isCh && iManage;
  $('riManageList').classList.toggle('hidden', !showManage);
  if (showManage) {
    $('riValType').textContent = room.privacy === 'public' ? t('info.public') : t('info.private');
    const perms = { sendMessages: true, sendMedia: true, addMembers: true, pinMessages: true, changeInfo: true, changeOwnTag: false, ...(room.perms || {}) };
    const on = ['sendMessages', 'sendMedia', 'addMembers', 'pinMessages', 'changeInfo', 'changeOwnTag'].filter((k) => perms[k]).length;
    $('riValPerms').textContent = on + '/6';
    const AD = { forever: t('info.ad.off'), '1d': t('info.ad.1d'), '1w': t('info.ad.1w'), '1mo': t('info.ad.1mo') };
    $('riValAutodel').textContent = AD[room.retention || 'forever'] || t('info.ad.off');
    $('riValHistory').textContent = room.historyVisible !== false ? t('info.histShown') : t('info.histHidden');
  }
  // Подгрузим ссылку, если ещё нет.
  if (room.id && !c._inviteLink) { resolveInviteLink(c).then(() => { if (state.activeId === c.id && !$('roomInfoScreen').classList.contains('hidden')) renderRoomInfo(c); }); }
}
$('riBack').onclick = () => $('roomInfoScreen').classList.add('hidden');
$('riMembers').onclick = () => $('btnMembers').onclick();
$('riAdd').onclick = () => $('btnInvite').onclick();
$('riCopy').onclick = async () => { const c = state.conversations.get(state.activeId); if (c?._inviteLink) { try { await navigator.clipboard.writeText(c._inviteLink); } catch {} $('riCopy').textContent = '✔'; setTimeout(() => ($('riCopy').textContent = '📋'), 1200); } };

// ── Управление группой: тип, разрешения, медленный режим, автоудаление, история ──
const GS_PERM_KEYS = ['sendMessages', 'sendMedia', 'addMembers', 'pinMessages', 'changeInfo', 'changeOwnTag'];
const GS_PERM_EL = { sendMessages: 'gpSendMessages', sendMedia: 'gpSendMedia', addMembers: 'gpAddMembers', pinMessages: 'gpPinMessages', changeInfo: 'gpChangeInfo', changeOwnTag: 'gpChangeOwnTag' };
function openGroupSettings(c) {
  const room = c._room || {};
  const perms = { sendMessages: true, sendMedia: true, addMembers: true, pinMessages: true, changeInfo: true, changeOwnTag: false, ...(room.perms || {}) };
  const isPub = room.privacy === 'public';
  $('gsPublic').checked = isPub; $('gsPrivate').checked = !isPub;
  for (const k of GS_PERM_KEYS) { const el = $(GS_PERM_EL[k]); if (el) el.checked = !!perms[k]; }
  $('gsSlow').value = String(room.slowModeSec || 0);
  $('gsRet').value = room.retention || 'forever';
  $('gsHistory').checked = room.historyVisible !== false;
  $('groupSetModal').classList.remove('hidden');
}
// Строки управления группой открывают модал настроек (тип/права/автоудаление/история).
for (const id of ['riRowType', 'riRowPerms', 'riRowAutodel', 'riRowHistory']) {
  $(id).onclick = () => { const c = state.conversations.get(state.activeId); if (c) openGroupSettings(c); };
}
$('riRowMembers').onclick = () => $('btnMembers').onclick();
$('riRowLink').onclick = () => { const c = state.conversations.get(state.activeId); if (c && c._inviteLink) { try { navigator.clipboard.writeText(c._inviteLink); } catch {} toast(t('common.copied') || 'Скопировано'); } };
$('gsCancel').onclick = () => $('groupSetModal').classList.add('hidden');
$('gsSave').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  const perms = {}; for (const k of GS_PERM_KEYS) { const el = $(GS_PERM_EL[k]); perms[k] = !!(el && el.checked); }
  const settings = { privacy: $('gsPublic').checked ? 'public' : 'private', slowModeSec: Number($('gsSlow').value) || 0, historyVisible: $('gsHistory').checked, perms };
  const retention = $('gsRet').value || 'forever';
  $('gsSave').disabled = true;
  try {
    const room = await window.prizrak.roomSettings({ roomId: c.roomId, settings });
    if ((c._room?.retention || 'forever') !== retention) { try { await window.prizrak.roomRetention({ roomId: c.roomId, retention }); } catch (e) {} }
    c._room = { ...(room || c._room), retention };
    $('groupSetModal').classList.add('hidden');
    toast(t('gset.saved'));
    renderRoomInfo(c); refreshComposer();
  } catch (e) { alert(t('gset.title') + ': ' + e.message); }
  finally { $('gsSave').disabled = false; }
};
$('riMute').onclick = () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  if (isChatMuted(c)) { c.mutedUntil = 0; syncMuted(); renderConvList(); renderRoomInfo(c); schedulePersist(); }
  else openMuteModal(c);
};
$('riJoin').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  try { const room = await window.prizrak.roomJoin({ roomId: c.roomId }); c._room = room; if (c.type === 'channel') loadChannelHistory(c); refreshComposer(); renderRoomInfo(c); renderConvList(); schedulePersist(); }
  catch (e) { alert('Не удалось вступить: ' + e.message); }
};
$('riLeave').onclick = async () => {
  const c = state.conversations.get(state.activeId); if (!c) return;
  if (!(await confirmAsk(`Выйти из «${c.title}»? Чат будет удалён из списка.`))) return;
  try { await window.prizrak.roomLeave({ roomId: c.roomId }); } catch (e) { alert('Ошибка выхода: ' + e.message); return; }
  state.conversations.delete(c.id);
  state.activeId = null; updateChatHeader(null); $('messages').innerHTML = '';
  $('roomInfoScreen').classList.add('hidden'); renderConvList(); schedulePersist();
};
// (клик по шапке чата обрабатывается на #chatHead — см. выше)
function roleOf(room, u) { if (room.owner === u) return t('roles.owner'); if (room.admins.includes(u)) return t('roles.admin'); if ((room.moderators || []).includes(u)) return t('roles.moderator'); return t('roles.member'); }
function rankOf(room, u) { if (room.owner === u) return 3; if (room.admins.includes(u)) return 2; if ((room.moderators || []).includes(u)) return 1; return 0; }
function iModerate(room, me) { return room.owner === me || room.admins.includes(me) || (room.moderators || []).includes(me); }
// ── Список участников в стиле Telegram (аватар, имя, статус, бейдж роли) ──────
function roleBadge(room, u) {
  const rk = rankOf(room, u);
  if (rk === 0) return '';
  const cls = rk === 3 ? 'owner' : rk === 2 ? 'admin' : 'mod';
  return `<span class="mrole ${cls}">${esc(roleOf(room, u))}</span>`;
}
function renderMembers(room) {
  const me = state.me.userId; const iOwn = room.owner === me; const iManage = iOwn || room.admins.includes(me);
  const box = $('membersList'); box.innerHTML = '';
  // Режим «только чтение» для групп (управляющим) — отдельной строкой-переключателем.
  if (room.type === 'group' && iManage) {
    const r = document.createElement('label'); r.className = 'tg-row ro-row';
    r.innerHTML = `<span class="tg-ic" style="background:#8b93a7">🔒</span><span class="tg-lbl">${esc(t('members.readonly'))}</span><span class="tg-switch"><input type="checkbox" ${room.readOnly ? 'checked' : ''}><i></i></span>`;
    r.querySelector('input').onchange = () => memberAction(room, 'ro', '');
    box.appendChild(r);
  }
  const rows = {};
  const all = [...new Set([room.owner, ...room.admins, ...(room.moderators || []), ...room.members, ...(room.subscribers || [])])];
  const mkRow = (u, banned) => {
    const div = document.createElement('div'); div.className = 'mrow' + (banned ? ' banned' : ''); div.dataset.u = u;
    const badge = banned ? `<span class="mrole ban">${esc(t('members.banned'))}</span>` : roleBadge(room, u);
    div.innerHTML = `<div class="mava">👤</div><div class="mmeta"><div class="mname">${esc(u.split(':')[0])}</div><div class="mstatus">${esc(u)}</div></div>${badge}`;
    div.onclick = (e) => openMemberMenu(e, room, u, banned);
    box.appendChild(div); rows[u] = div;
    return div;
  };
  for (const u of all) mkRow(u, false);
  for (const u of (room.banned || [])) mkRow(u, true);
  // Асинхронно обогащаем аватарами/именами и статусом присутствия (как в Telegram).
  for (const u of [...all, ...(room.banned || [])]) {
    (async () => {
      try { const p = await window.prizrak.getProfile({ userId: u }); const d = rows[u]; if (!d) return; if (p.avatar) d.querySelector('.mava').innerHTML = `<img src="${avatarUrl(p.avatar)}" alt="">`; if (p.displayName) d.querySelector('.mname').textContent = p.displayName; } catch {}
      try { const pr = await window.prizrak.presence({ userId: u }); const d = rows[u]; if (!d) return; const f = formatPresence(pr); const st = d.querySelector('.mstatus'); if (f.text) { st.textContent = f.text; st.className = 'mstatus' + (f.cls ? ' ' + f.cls : ''); } } catch {}
    })();
  }
}
// Меню действий над участником (для владельца/админа) — как в Telegram по тапу.
function openMemberMenu(e, room, u, banned) {
  e.preventDefault(); e.stopPropagation();
  const me = state.me.userId; const iOwn = room.owner === me; const iManage = iOwn || room.admins.includes(me);
  const kind = t(room.type === 'channel' ? 'kind.channel' : 'kind.group');
  const items = [];
  if (banned) { if (iManage) items.push({ icon: '♻️', label: t('mm.unban'), action: () => memberAction(room, 'unban', u) }); }
  else {
    if (iManage && u !== room.owner) {
      if (rankOf(room, u) < 2) items.push({ icon: '⭐', label: t('mm.admin'), action: () => memberAction(room, 'admin', u) });
      if (rankOf(room, u) !== 1) items.push({ icon: '🛡', label: t('mm.moderator'), action: () => memberAction(room, 'moderator', u) });
      if (rankOf(room, u) > 0) items.push({ icon: '➖', label: t('mm.demote'), action: () => memberAction(room, 'member', u) });
    }
    if (iModerate(room, me) && u !== room.owner && u !== me && rankOf(room, me) > rankOf(room, u)) {
      if (items.length) items.push({ sep: true });
      items.push({ icon: '👢', label: t('mm.kick', { kind }), danger: true, action: () => memberAction(room, 'kick', u) });
      items.push({ icon: '🚫', label: t('mm.ban'), danger: true, action: () => memberAction(room, 'ban', u) });
    }
    if (iOwn && u !== room.owner) { if (items.length) items.push({ sep: true }); items.push({ icon: '👑', label: t('mm.transfer'), danger: true, action: () => memberAction(room, 'owner', u) }); }
  }
  if (!items.length) return; // у обычного участника нет действий
  showCtxMenu(e.clientX, e.clientY, items);
}
async function memberAction(room, act, u) {
  try {
    if (act === 'ro') await window.prizrak.roomReadonly({ roomId: room.id, readOnly: !room.readOnly });
    else if (act === 'owner') { if (!(await confirmAsk(t('mm.transferAsk', { u })))) return; await window.prizrak.roomTransfer({ roomId: room.id, newOwner: u }); }
    else if (act === 'kick') { if (!(await confirmAsk(t('mm.kickAsk', { u })))) return; await window.prizrak.roomKick({ roomId: room.id, userId: u }); }
    else if (act === 'ban') { if (!(await confirmAsk(t('mm.banAsk', { u })))) return; await window.prizrak.roomBan({ roomId: room.id, userId: u }); }
    else if (act === 'unban') await window.prizrak.roomUnban({ roomId: room.id, userId: u });
    else await window.prizrak.roomRole({ roomId: room.id, userId: u, role: act });
    const fresh = (await window.prizrak.listRooms()).find((x) => x.id === room.id); if (fresh) { const c = state.conversations.get(room.id); if (c) c._room = fresh; renderMembers(fresh); }
  } catch (e) { alert(e.message); }
}

// ── Вступление по ссылке prizrak:// (клик в браузере открыл приложение) ──────
window.prizrak.onOpenedRoom((room) => {
  ensureConv(room.id, { type: room.type, title: room.name, roomId: room.id, avatar: room.avatar });
  renderConvList(); selectConv(room.id);
});
window.prizrak.onOpenedDm((userId) => {
  ensureConv(userId, { type: 'direct', title: userId, peerId: userId });
  renderConvList(); selectConv(userId);
});
window.prizrak.onDeeplinkError((msg) => alert('Ссылка-приглашение: ' + msg));
// «Открыть в отдельном окне»: новое окно фокусируется на этом чате.
window.prizrak.onFocusChat((chat) => {
  if (!chat) return;
  ensureConv(chat.id, { type: chat.type, title: chat.title, peerId: chat.peerId, roomId: chat.roomId });
  renderConvList(); selectConv(chat.id);
});

// ── Тема, поиск, настройки приложения ────────────────────────────────────────
function applyTheme(t) {
  state.theme = t;
  const light = t === 'light' || (t === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.body.classList.toggle('light', !!light);
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-theme') === t));
}
$('chatSearch').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderConvList(); });

// ── Нижнее меню (Контакты · Звонки · Чаты · Настройки) ───────────────────────
function switchTab(tab) {
  if (tab === 'settings') { openSettings(); return; }
  state.tab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
  $('chatsPanel').classList.toggle('hidden', tab !== 'chats');
  $('contactsPanel').classList.toggle('hidden', tab !== 'contacts');
  $('callsPanel').classList.toggle('hidden', tab !== 'calls');
  if (tab === 'contacts') renderContacts();
  if (tab === 'calls') renderCalls();
}
document.querySelectorAll('.nav-btn').forEach((b) => { b.onclick = () => switchTab(b.getAttribute('data-tab')); });

// Контакты: личные собеседники (из чатов). Клик — открыть чат.
function renderContacts() {
  const q = ($('contactSearch').value || '').toLowerCase();
  const list = $('contactsList'); list.innerHTML = '';
  const peers = [...state.conversations.values()].filter((c) => c.type === 'direct');
  const seen = new Set(); let n = 0;
  for (const c of peers) {
    if (seen.has(c.peerId)) continue; seen.add(c.peerId);
    if (q && !String(c.title).toLowerCase().includes(q) && !String(c.peerId).toLowerCase().includes(q)) continue;
    const d = document.createElement('div'); d.className = 'conv';
    const av = c.avatar ? `<img src="${avatarUrl(c.avatar)}" alt="">` : '👤';
    d.innerHTML = `<div class="avatar">${av}</div><div class="meta"><div class="name">${esc(c.title)}</div><div class="last">${esc(c.peerId)}</div></div>`;
    d.onclick = () => { switchTab('chats'); selectConv(c.id); }; list.appendChild(d); n++;
  }
  if (!n) ;
}
$('contactSearch').addEventListener('input', renderContacts);
$('addContact').onclick = () => openModal(t('contacts.add'), 'user:domain', 'bob:example.org', (v) => {
  const peer = normId(v); ensureConv(peer, { type: 'direct', title: peer, peerId: peer }); renderContacts(); switchTab('chats'); selectConv(peer);
});

// Звонки: история из системных отметок звонков (пока просто заглушка/список).
function renderCalls() {
  const list = $('callsList'); list.innerHTML = `<div class="hint" style="padding:16px">${esc(t('calls.emptyHint'))}</div>`;
}

// ── Экран настроек (как в Telegram) ──────────────────────────────────────────
// Master-detail: показать секцию настроек в правой колонке.
function switchSetSec(sec) {
  document.querySelectorAll('#settingsScreen .set-nav-row[data-sec]').forEach((r) => r.classList.toggle('active', r.getAttribute('data-sec') === sec));
  document.querySelectorAll('#settingsScreen .set-sec').forEach((s) => s.classList.toggle('hidden', s.getAttribute('data-sec') !== sec));
}
function markLangPick() { document.querySelectorAll('#settingsScreen .lang-pick').forEach((r) => r.classList.toggle('on', r.getAttribute('data-lang') === (state.lang || 'en'))); }
async function openSettings() {
  applyTheme(state.theme);
  if (state.me) { $('setName').textContent = state.me.userId.split(':')[0]; $('setId').textContent = state.me.userId; }
  try { const p = await window.prizrak.getProfile({ userId: state.me.userId }); const a = avatarUrl(p.avatar); $('setAva').innerHTML = a ? `<img src="${a}" alt="">` : '👤'; if (p.displayName) $('setName').textContent = p.displayName; } catch {}
  try { const a = await window.prizrak.getAutostart(); $('setAutostart').checked = !!a.enabled; } catch {}
  try { const c = await window.prizrak.getCloseToTray(); $('setCloseTray').checked = !!c.enabled; } catch {}
  $('setNotif').checked = state.notif !== false;
  $('setSound').checked = state.sound !== false;
  $('setLinkPrev').checked = state.linkPreviews !== false;
  await refreshWallet();
  $('setUpdInfo').textContent = '';
  switchSetSec('appearance'); markLangPick();
  $('settingsScreen').classList.remove('hidden');
}
$('setBack').onclick = () => $('settingsScreen').classList.add('hidden');
document.querySelectorAll('#settingsScreen .set-nav-row[data-sec]').forEach((r) => r.onclick = () => {
  switchSetSec(r.getAttribute('data-sec'));
  if (r.getAttribute('data-sec') === 'privacy') refreshPrivacyRows();
  if (r.getAttribute('data-sec') === 'vpn') refreshVpn();
});

// ── 🛡 Призрак-VPN: маскировка, свой узел, выбор страны с рейтингом ────────────
// Флаг считаем из ISO-кода (regional indicator) — работает для ЛЮБОЙ страны без справочника.
function vpnFlag(code) {
  const cc = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (cc.length !== 2) return '🏳️';
  return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65);
}
const VPN_NAME = { FR:'Франция',DE:'Германия',NL:'Нидерланды',BE:'Бельгия',SE:'Швеция',GB:'Великобритания',US:'США',CH:'Швейцария',ES:'Испания',PL:'Польша',FI:'Финляндия',NO:'Норвегия',DK:'Дания',CA:'Канада',IE:'Ирландия',AT:'Австрия',CZ:'Чехия',LT:'Литва',SG:'Сингапур',JP:'Япония',HK:'Гонконг',KR:'Южная Корея',AU:'Австралия',IT:'Италия',RO:'Румыния',BG:'Болгария',LV:'Латвия',EE:'Эстония',UA:'Украина',TR:'Турция',AE:'ОАЭ',IN:'Индия',BR:'Бразилия',IL:'Израиль',MD:'Молдова',KZ:'Казахстан',GE:'Грузия',AM:'Армения',RS:'Сербия',HU:'Венгрия',SK:'Словакия',SI:'Словения',HR:'Хорватия',GR:'Греция',PT:'Португалия',LU:'Люксембург',IS:'Исландия' };
let _vpnState = { state:'off', country:null, node:false, available:false };
let _vpnPaidUntil = 0;
function vpnApi() { return (window.prizrak && window.prizrak.vpn) || null; }
function vpnPaid() { return _vpnPaidUntil > Math.floor(Date.now()/1000); }
function starsHtml(v) {
  if (v == null) return '<span class="hint-sm">нет оценок</span>';
  const f = Math.round(v);
  return '<span style="color:#f5c518">' + '★'.repeat(f) + '<span style="color:#333">' + '★'.repeat(5-f) + '</span></span> '
    + '<span class="hint-sm">' + v.toFixed(2) + ' из 5</span>';
}
async function refreshVpn() {
  const api = vpnApi();
  try { if (api) _vpnState = await api.status(); } catch {}
  try { if (api && api.sub) _vpnPaidUntil = await api.sub(); } catch {}
  $('vpnUnavail').classList.toggle('hidden', _vpnState.available !== false);
  $('vpnMask').checked = ['up','connecting','switching','searching'].includes(_vpnState.state);
  $('vpnNode').checked = !!_vpnState.node;
  // Статус подписки.
  const paid = vpnPaid();
  if ($('vpnSubText')) $('vpnSubText').textContent = paid ? ('Оплачено до ' + new Date(_vpnPaidUntil*1000).toLocaleDateString('ru-RU')) : 'Не оплачено';
  if ($('vpnSubIco')) $('vpnSubIco').style.background = paid ? '#42b96b' : '#e0555a';
  if ($('vpnSubHint')) $('vpnSubHint').textContent = paid ? 'VPN активен — выберите страну' : 'Оплатите призраками, чтобы пользоваться VPN';
  if ($('vpnPay')) $('vpnPay').textContent = paid ? 'Продлить на месяц' : 'Оплатить VPN';
  // Страны с рейтингом — с сервера.
  let list = [];
  try { if (window.prizrak.vpnCountries) list = await window.prizrak.vpnCountries(); } catch {}
  const box = $('vpnCountries');
  if (!list || !list.length) { box.innerHTML = '<div class="hint" data-i18n="vpn.none">Пока нет доступных выходов. Появятся, как только заработают узлы.</div>'; return; }
  box.innerHTML = list.map((c) => {
    const flag = vpnFlag(c.code), name = c.name || VPN_NAME[c.code] || c.code;
    const sel = _vpnState.country === c.code ? '<span style="color:var(--accent)">✓</span>' : '<span class="chev">›</span>';
    return '<button class="set-row vpn-cty" data-code="' + c.code + '"><span class="ic tile" style="background:transparent;font-size:20px">' + flag + '</span>'
      + '<span class="lbl"><b>' + name + '</b><br>' + starsHtml(typeof c.rating === 'number' ? c.rating : null) + '</span>'
      + '<span class="val">' + (c.nodes || 0) + ' узл.</span>' + sel + '</button>';
  }).join('');
  document.querySelectorAll('#vpnCountries .vpn-cty').forEach((b) => b.onclick = () => chooseVpnCountry(b.getAttribute('data-code')));
}
async function chooseVpnCountry(code) {
  const api = vpnApi();
  if (!api) { toast(t('vpn.unavail')); return; }
  if (!vpnPaid()) { toast('Сначала оплатите VPN'); return; }
  try {
    const r = await api.connect(code);   // получает ордер у Банка + поднимает туннель
    _vpnState.country = code;
    if (r && r.paidUntil) _vpnPaidUntil = r.paidUntil;
    toast('Призрак включён (' + code + '). Укажите SOCKS5-прокси ' + (r && r.proxy ? r.proxy : '127.0.0.1:10808') + ' в системе или браузере.');
    refreshVpn();
  } catch (e) { toast('VPN: ' + e.message); }
}
if ($('vpnPay')) $('vpnPay').onclick = async () => {
  const api = vpnApi();
  if (!api) { toast(t('vpn.unavail')); return; }
  try { const r = await api.subscribe(1); _vpnPaidUntil = r.paidUntil || 0; toast('VPN оплачен 🛡'); refreshVpn(); }
  catch (e) { toast('Оплата: ' + e.message); }
};
if ($('vpnMask')) $('vpnMask').onchange = async (e) => {
  const api = vpnApi();
  if (!api) { e.target.checked = false; toast(t('vpn.unavail')); return; }
  if (e.target.checked && !vpnPaid()) { e.target.checked = false; toast('Сначала оплатите VPN'); return; }
  try {
    if (e.target.checked) { await chooseVpnCountry(_vpnState.country || 'FR'); }
    else { await api.maskOff(); toast('Призрак выключен.'); refreshVpn(); }
  }
  catch (err) { e.target.checked = false; toast('VPN: ' + err.message); }
};
if ($('vpnNode')) $('vpnNode').onchange = async (e) => {
  const api = vpnApi();
  if (!api) { e.target.checked = false; toast(t('vpn.unavail')); return; }
  try { if (e.target.checked) await api.nodeOn(); else await api.nodeOff(); _vpnState.node = e.target.checked; }
  catch (err) { e.target.checked = false; toast('Узел: ' + err.message); }
};

// ── 🔒 Конфиденциальность: чёрный список + политики «Группы и каналы»/«Звонки» ──
// state.privacy кэшируется: enforcement звонков смотрит сюда, не дёргая сервер.
function privModeLabel(mode, extra) {
  const base = mode === 'none' ? t('priv.nobody') : mode === 'contacts' ? t('priv.contacts') : t('priv.all');
  return extra > 0 ? `${base} (+${extra})` : base;
}
async function loadPrivacy(force) {
  if (state.privacy && !force) return state.privacy;
  try { state.privacy = await window.prizrak.getPrivacy(); } catch { state.privacy = { blocked: [], groups: 'all', groupsAllow: [], calls: 'all', callsAllow: [] }; }
  return state.privacy;
}
async function savePrivacy(next) {
  state.privacy = next; refreshPrivacyRows(); renderPrivDetail();
  try { state.privacy = await window.prizrak.setPrivacy({ privacy: next }); } catch (e) { toast(e.message); }
  refreshPrivacyRows(); renderPrivDetail();
}
async function refreshPrivacyRows() {
  const pv = await loadPrivacy();
  $('privBlockedVal').textContent = (pv.blocked || []).length || '';
  $('privGroupsVal').textContent = privModeLabel(pv.groups, (pv.groupsAllow || []).length);
  $('privCallsVal').textContent = privModeLabel(pv.calls, (pv.callsAllow || []).length);
}
let _privKind = 'blocked';
function renderPrivDetail() {
  const pv = state.privacy; if (!pv) return;
  const isBlocked = _privKind === 'blocked';
  const modeKey = _privKind === 'groups' ? 'groups' : 'calls';
  const allowKey = _privKind === 'groups' ? 'groupsAllow' : 'callsAllow';
  const list = isBlocked ? (pv.blocked || []) : (pv[allowKey] || []);
  $('privDetailTitle').textContent = isBlocked ? t('priv.blocked') : _privKind === 'groups' ? t('priv.groups') : t('priv.calls');
  $('privModeBox').classList.toggle('hidden', isBlocked);
  if (!isBlocked) {
    $('privModeCap').textContent = _privKind === 'groups' ? t('priv.whoGroups') : t('priv.whoCalls');
    $('privModeHint').textContent = _privKind === 'groups' ? t('priv.groupsHint') : t('priv.callsHint');
    document.querySelectorAll('#settingsScreen .priv-mode').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === (pv[modeKey] || 'all')));
  }
  $('privListCap').textContent = isBlocked ? t('priv.blockedCap') : t('priv.alwaysAllow');
  $('privListHint').textContent = isBlocked ? t('priv.hint') : t('priv.allowHint');
  const box = $('privList'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = `<div class="hint" style="padding:12px 14px">${esc(isBlocked ? t('priv.emptyBlocked') : t('priv.emptyAllow'))}</div>`; return; }
  for (const id of list) {
    const row = document.createElement('div'); row.className = 'priv-item';
    row.innerHTML = `<div class="priv-nm"><b>${esc(id.split(':')[0])}</b><span>${esc(id)}</span></div>`;
    const btn = document.createElement('button'); btn.className = 'ghost-btn sm'; btn.textContent = isBlocked ? t('priv.unblock') : t('priv.remove');
    btn.onclick = () => savePrivacy({ ...state.privacy, [isBlocked ? 'blocked' : allowKey]: list.filter((x) => x !== id) });
    row.appendChild(btn); box.appendChild(row);
  }
}
document.querySelectorAll('#settingsScreen .set-row[data-priv]').forEach((r) => r.onclick = async () => {
  _privKind = r.getAttribute('data-priv'); await loadPrivacy(); switchSetSec('privacyDetail'); renderPrivDetail();
});
document.querySelectorAll('#settingsScreen .priv-mode').forEach((b) => b.onclick = () => {
  const modeKey = _privKind === 'groups' ? 'groups' : 'calls';
  savePrivacy({ ...state.privacy, [modeKey]: b.getAttribute('data-mode') });
});
$('privAddBtn').onclick = () => {
  const id = $('privAddInput').value.trim().replace(/^@/, '');
  if (!/^[^:\s]+:[^:\s]+$/.test(id)) return toast(t('priv.badId'));
  const isBlocked = _privKind === 'blocked';
  const key = isBlocked ? 'blocked' : (_privKind === 'groups' ? 'groupsAllow' : 'callsAllow');
  const list = state.privacy[key] || [];
  if (list.includes(id)) return toast(t('priv.already'));
  $('privAddInput').value = '';
  savePrivacy({ ...state.privacy, [key]: [...list, id] });
};
$('privAddInput').onkeydown = (e) => { if (e.key === 'Enter') $('privAddBtn').click(); };
// Можно ли принять звонок от peer (ЧС + политика «Звонки»).
function callAllowedFrom(from) {
  const pv = state.privacy; if (!pv || !from) return true;
  if ((pv.blocked || []).includes(from)) return false;
  if ((pv.callsAllow || []).includes(from)) return true;
  const m = pv.calls || 'all';
  if (m === 'all') return true;
  if (m === 'none') return false;
  return [...state.conversations.values()].some((c) => c.type === 'direct' && c.peerId === from);
}
document.querySelectorAll('.seg-btn').forEach((b) => { b.onclick = () => { applyTheme(b.getAttribute('data-theme')); schedulePersist(); }; });
// ── Выбор языка интерфейса (секция «Язык») ───────────────────────────────────
document.querySelectorAll('#settingsScreen .lang-pick').forEach((r) => r.onclick = () => { setLang(r.getAttribute('data-lang')); markLangPick(); });
$('setAutostart').onchange = (e) => window.prizrak.setAutostart({ enabled: e.target.checked });
$('setNotif').onchange = (e) => { state.notif = e.target.checked; try { window.prizrak.setNotif({ enabled: state.notif }); } catch {} schedulePersist(); };
$('setSound').onchange = (e) => { state.sound = e.target.checked; schedulePersist(); if (e.target.checked) playIncomingSound(); };
$('setLinkPrev').onchange = (e) => { state.linkPreviews = e.target.checked; schedulePersist(); };
$('setCloseTray').onchange = (e) => { try { window.prizrak.setCloseToTray({ enabled: e.target.checked }); } catch {} };
$('setCheckUpd').onclick = async () => {
  $('setUpdInfo').textContent = t('checkupd.checking');
  try {
    const u = await window.prizrak.checkUpdate();
    if (u.error) { $('setUpdInfo').textContent = t('checkupd.fail', { e: u.error }); return; }
    if (u.ready) $('setUpdInfo').textContent = t('checkupd.ready', { v: u.latest });         // скачано и проверено — жми зелёную плашку
    else if (u.downloading) $('setUpdInfo').textContent = t('checkupd.downloading', { p: u.percent || 0 });
    else $('setUpdInfo').textContent = t('checkupd.latest', { cur: u.current });
  } catch (e) { $('setUpdInfo').textContent = e.message; }
};

// ── Обновления: зелёная плашка «Обновить Prizrak» вместо нижней панели ────────
function showUpdateBar(mode, data) {
  const bar = $('updateBar'), nav = $('bottomNav'), lbl = $('updateBarLbl');
  if (!bar || !nav) return;
  if (mode === 'ready') {
    lbl.textContent = t('upd.button'); bar.classList.remove('downloading', 'hidden');
    bar.title = (data && data.version) ? t('upd.readyTitle', { v: data.version }) : '';
    nav.classList.add('hidden');
  } else if (mode === 'downloading') {
    lbl.textContent = t('upd.downloading', { p: (data && data.percent) || 0 });
    bar.classList.add('downloading'); bar.classList.remove('hidden');
    nav.classList.add('hidden');
  } else { bar.classList.add('hidden'); nav.classList.remove('hidden'); }
}
$('updateBar').onclick = async () => {
  if ($('updateBar').classList.contains('downloading')) return; // во время загрузки клик игнорируем
  $('updateBarLbl').textContent = t('upd.installing');
  try { await window.prizrak.updateInstall(); } catch {}
};
window.prizrak.onUpdateStatus((d) => {
  if (d.kind === 'downloading') showUpdateBar('downloading', d);
  else if (d.kind === 'ready') showUpdateBar('ready', d);
  else if (d.kind === 'error') showUpdateBar('hide');
  // Живой статус и в строке настроек «Проверить обновления»: во время загрузки
  // показываем «Скачиваю обновление… XX%», а не молчаливое «Проверяю…».
  const info = $('setUpdInfo');
  if (info) {
    if (d.kind === 'downloading') info.textContent = t('checkupd.downloading', { p: d.percent || 0 });
    else if (d.kind === 'ready') info.textContent = t('checkupd.ready', { v: d.version || '' });
    else if (d.kind === 'error') info.textContent = t('checkupd.fail', { e: d.error || '' });
  }
});
async function initUpdateBar() {
  try { const s = await window.prizrak.updateState(); if (s.state === 'ready') showUpdateBar('ready', s.info || {}); else if (s.state === 'downloading') showUpdateBar('downloading', { percent: s.percent }); } catch {}
}

// ── Живучесть соединения: как только окно снова в фокусе или вернулась сеть —
// пингуем сервер и при необходимости пересоздаём WS (чинит «зомби»-коннект).
try {
  const poke = () => {
    try { window.prizrak.netPoke && window.prizrak.netPoke(); } catch {}
    // Догоняем посты активного канала/группы (они не приходят через опрос личных сообщений).
    try { const c = state.conversations.get(state.activeId); if (c && c.type === 'channel') loadChannelHistory(c); else if (c && c.type === 'group') loadRoomReactions(c); } catch {}
  };
  window.addEventListener('focus', poke);
  window.addEventListener('online', poke);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poke(); });
} catch {}

// ── Старт: автологин или экран входа ─────────────────────────────────────────
(async function boot() {
  if (!state.lang) state.lang = detectLang(); // язык интерфейса до логина — по системе
  applyI18n();
  try {
    const b = await window.prizrak.bootstrap();
    if (b.loggedIn) { await enterApp(b.me); return; }
  } catch {}
  refreshServerInfo();
})();
