package com.prizrakmobile.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * BootReceiver — авто-подъём VPN после перезагрузки, если он был включён.
 * Работает как дополнение к системному Always-on VPN: даже без него, если
 * пользователь ранее включил Призрак-VPN и дал согласие, поднимаем сервис сам.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        val a = intent?.action ?: return
        if (a == Intent.ACTION_BOOT_COMPLETED || a == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            a == "android.intent.action.QUICKBOOT_POWERON") {
            val p = PrizrakVpnService.prefs(ctx)
            if (!p.getBoolean(PrizrakVpnService.K_ENABLED, false)) return
            val i = Intent(ctx, PrizrakVpnService::class.java).apply {
                action = PrizrakVpnService.ACTION_START
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {}
        }
    }
}
