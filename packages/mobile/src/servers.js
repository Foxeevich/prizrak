// Список публичных серверов Prizrak для экрана входа (как в десктоп-клиенте).
// Пользователь вводит только логин — домен подставляется из выбранного сервера,
// порт не нужен (клиент сканирует порты через resolveBaseUrl).
export const SERVERS = [
  {id: 'prizrak', label: 'Prizrak.im (WorldWide)', domain: 'prizrak.im'},
  {id: 'targethack', label: 'prizrak.targethack.org (Russia)', domain: 'prizrak.targethack.org'},
  {id: 'phoenix', label: 'prizrak.phoenix.lol', domain: 'prizrak.phoenix.lol'},
  {id: 'custom', label: 'Свой сервер', domain: ''},
];
