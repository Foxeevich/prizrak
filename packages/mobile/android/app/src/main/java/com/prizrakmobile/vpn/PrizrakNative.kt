package com.prizrakmobile.vpn

/**
 * PrizrakNative — мост к нативному data plane (Rust, libprizrak_core.so).
 * Поднимает локальный SOCKS5, который на каждый CONNECT строит нативную цепочку
 * relay→exit («Тень» целиком в нативе). Весь трафик и крипта — мимо JS: скорость.
 */
object PrizrakNative {
    @Volatile private var loaded = false

    private fun ensure() {
        if (!loaded) {
            System.loadLibrary("prizrak_core")
            loaded = true
        }
    }

    /** Запустить нативный SOCKS5 на 127.0.0.1:port с параметрами цепочки из ордера. */
    fun start(
        port: Int,
        relayHost: String, relayPort: Int, relayPub: String,
        exitHost: String, exitPort: Int, exitPub: String,
        orderJson: String
    ) {
        ensure()
        nativeStart(port, relayHost, relayPort, relayPub, exitHost, exitPort, exitPub, orderJson)
    }

    /** Обновить ордер на лету (продление) — SOCKS не перезапускается. */
    fun updateOrder(
        relayHost: String, relayPort: Int, relayPub: String,
        exitHost: String, exitPort: Int, exitPub: String,
        orderJson: String
    ) {
        ensure()
        nativeUpdateOrder(relayHost, relayPort, relayPub, exitHost, exitPort, exitPub, orderJson)
    }

    fun stop() {
        if (loaded) nativeStop()
    }

    /** Подписать тело запроса к Банку ghost-ключом (Ed25519). Возвращает hex-подпись. */
    fun sign(seedHex: String, body: String): String {
        ensure()
        return nativeSign(seedHex, body)
    }

    private external fun nativeStart(
        port: Int,
        relayHost: String, relayPort: Int, relayPub: String,
        exitHost: String, exitPort: Int, exitPub: String,
        orderJson: String
    )
    private external fun nativeUpdateOrder(
        relayHost: String, relayPort: Int, relayPub: String,
        exitHost: String, exitPort: Int, exitPub: String,
        orderJson: String
    )
    private external fun nativeStop()
    private external fun nativeSign(seedHex: String, body: String): String
}
