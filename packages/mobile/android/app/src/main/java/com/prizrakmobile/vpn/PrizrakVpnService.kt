package com.prizrakmobile.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import hev.htproxy.TProxyService
import java.io.File

/**
 * PrizrakVpnService — системный tun + ЖИВУЧЕСТЬ (always-on / после ребута).
 *
 * Сервис САМ добывает свежий ордер у Банка (PrizrakOrders, подпись в нативе) и
 * поднимает нативную цепочку — без участия JS. Поэтому он оживает после
 * перезагрузки (Android always-on стартует его напрямую), продлевает ордер до
 * истечения и переподключается при смене сети. Как WireGuard, но по ордерам.
 */
class PrizrakVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.prizrakmobile.vpn.START"
        const val ACTION_STOP = "com.prizrakmobile.vpn.STOP"
        private const val CHAN = "prizrak_vpn"
        private const val NOTIF_ID = 0x7011

        const val PREFS = "prizrak_vpn"
        const val K_BANK = "bankUrl"
        const val K_USER = "userId"
        const val K_SEED = "ghostSeed"
        const val K_COUNTRY = "country"
        const val K_PORT = "socksPort"
        const val K_ENABLED = "enabled"

        @Volatile var running = false
        @Volatile var currentCountry: String? = null

        private const val TUN_ADDR = "198.18.0.1"
        private const val TUN_MASK = 30
        private const val DNS_ADDR = "198.18.0.2"
        private const val MAP_NET = "100.64.0.0"
        private const val MAP_MASK = 10
        private const val MTU = 8500

        // Ордер живёт 1 час — продлеваем заранее.
        private const val REFRESH_MS = 45L * 60L * 1000L

        fun prefs(ctx: Context): SharedPreferences =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    private var tun: ParcelFileDescriptor? = null
    @Volatile private var worker: Thread? = null
    private var netCb: ConnectivityManager.NetworkCallback? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                prefs(this).edit().putBoolean(K_ENABLED, false).apply()
                stopTunnel()
                return START_NOT_STICKY
            }
            else -> {
                // Старт от пользователя ИЛИ от системы (always-on/после ребута).
                val p = prefs(this)
                currentCountry = p.getString(K_COUNTRY, null)
                startForeground(NOTIF_ID, buildNotification(currentCountry))
                if (!running) establishAsync()
            }
        }
        return START_STICKY // система перезапустит сервис, если его убьют
    }

    /** Достать ордер и поднять туннель в фоне (сеть после ребута может быть не готова). */
    private fun establishAsync() {
        if (worker != null) return
        running = true
        val t = Thread {
            val p = prefs(this)
            val bank = p.getString(K_BANK, "") ?: ""
            val user = p.getString(K_USER, "") ?: ""
            val seed = p.getString(K_SEED, "") ?: ""
            val country = p.getString(K_COUNTRY, "") ?: ""
            val port = p.getInt(K_PORT, 10808)
            if (bank.isEmpty() || user.isEmpty() || seed.isEmpty()) { running = false; stopSelf(); return@Thread }

            // Свежий ордер с повторами (сеть после ребута поднимается не сразу).
            var chain: PrizrakOrders.Chain? = null
            var tries = 0
            while (running && tries < 20 && chain == null) {
                chain = PrizrakOrders.fetch(bank, user, seed, country)
                if (chain == null) { tries++; try { Thread.sleep(4000) } catch (_: Throwable) {} }
            }
            if (!running) return@Thread
            val ch = chain ?: run { running = false; stopSelf(); return@Thread }

            PrizrakNative.start(port, ch.relayHost, ch.relayPort, ch.relayPub, ch.exitHost, ch.exitPort, ch.exitPub, ch.orderJson)
            if (!buildTun(port)) { running = false; stopTunnel(); return@Thread }

            registerNetworkCallback(bank, user, seed, country, port)
            // Цикл продления ордера.
            while (running) {
                try { Thread.sleep(REFRESH_MS) } catch (_: Throwable) {}
                if (!running) break
                val fresh = PrizrakOrders.fetch(bank, user, seed, country)
                if (fresh != null) {
                    PrizrakNative.updateOrder(fresh.relayHost, fresh.relayPort, fresh.relayPub, fresh.exitHost, fresh.exitPort, fresh.exitPub, fresh.orderJson)
                }
            }
        }
        worker = t
        t.isDaemon = true
        t.start()
    }

    /** Поднять системный tun и запустить hev-socks5-tunnel на нативный SOCKS. */
    private fun buildTun(socksPort: Int): Boolean {
        return try {
            val builder = Builder()
                .setSession("Prizrak")
                .setMtu(MTU)
                .addAddress(TUN_ADDR, TUN_MASK)
                .addDnsServer(DNS_ADDR)
                .addRoute("0.0.0.0", 0)
                .addRoute(MAP_NET, MAP_MASK)
            try { builder.addDisallowedApplication(packageName) } catch (_: Exception) {}
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)
            val pfd = builder.establish() ?: return false
            tun = pfd
            val cfg = writeConfig(socksPort)
            val ok = try { TProxyService.TProxyStartService(cfg.absolutePath, pfd.fd) } catch (_: Throwable) { false }
            ok
        } catch (_: Throwable) {
            false
        }
    }

    /** При смене/восстановлении сети — берём свежий ордер (наш failover выберет живой узел). */
    private fun registerNetworkCallback(bank: String, user: String, seed: String, country: String, port: Int) {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val req = NetworkRequest.Builder()
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (!running) return
                    val fresh = PrizrakOrders.fetch(bank, user, seed, country)
                    if (fresh != null) {
                        PrizrakNative.updateOrder(fresh.relayHost, fresh.relayPort, fresh.relayPub, fresh.exitHost, fresh.exitPort, fresh.exitPub, fresh.orderJson)
                    }
                }
            }
            cm.registerNetworkCallback(req, cb)
            netCb = cb
        } catch (_: Throwable) {}
    }

    private fun writeConfig(socksPort: Int): File {
        val yaml = """
            tunnel:
              mtu: $MTU
            socks5:
              address: 127.0.0.1
              port: $socksPort
              udp: 'tcp'
            mapdns:
              address: $DNS_ADDR
              port: 53
              network: $MAP_NET
              netmask: 255.192.0.0
              cache-size: 10000
            misc:
              log-level: warn
        """.trimIndent()
        val f = File(cacheDir, "prizrak-tun2socks.yml")
        f.writeText(yaml)
        return f
    }

    private fun stopTunnel() {
        running = false
        worker?.interrupt(); worker = null
        try { netCb?.let { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } } catch (_: Throwable) {}
        netCb = null
        try { PrizrakNative.stop() } catch (_: Throwable) {}
        try { TProxyService.TProxyStopService() } catch (_: Throwable) {}
        try { tun?.close() } catch (_: Exception) {}
        tun = null
        currentCountry = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() { stopTunnel(); super.onDestroy() }
    override fun onRevoke() { stopTunnel(); super.onRevoke() }

    @Suppress("DEPRECATION")
    private fun buildNotification(country: String?): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHAN, "Призрак-VPN", NotificationManager.IMPORTANCE_LOW))
        }
        val where = country?.let { " · $it" } ?: ""
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHAN) else Notification.Builder(this)
        return b.setContentTitle("Призрак-VPN активен$where")
            .setContentText("Трафик устройства идёт через Призрак")
            .setSmallIcon(android.R.drawable.presence_online)
            .setOngoing(true)
            .build()
    }
}
