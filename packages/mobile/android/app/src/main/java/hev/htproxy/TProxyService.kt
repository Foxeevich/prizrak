package hev.htproxy

// Мост к нативному tun2socks (hev-socks5-tunnel). Имя класса/пакета зашито в
// нативной библиотеке (PKGNAME=hev/htproxy, CLSNAME=TProxyService) — не менять.
// Нативная либа читает конфиг (socks5-апстрим) и заворачивает весь трафик из
// переданного tun-fd в наш локальный SOCKS5.
object TProxyService {
    init {
        System.loadLibrary("hev-socks5-tunnel")
    }

    external fun TProxyStartService(configPath: String, fd: Int): Boolean
    external fun TProxyStopService(): Boolean
    external fun TProxyIsRunning(): Boolean
    external fun TProxyGetStats(): LongArray
}
