package com.prizrakmobile.vpn

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Мост JS ↔ нативный VpnService. JS-движок (packages/vpn) решает МАРШРУТ; этот
 * модуль включает/выключает системный tun и сообщает состояние в UI.
 *
 * Методы: maskOn(country) / maskOff() / switchCountry(country) / nodeOn() /
 * nodeOff() / status(). События: vpnState, vpnNotice.
 */
class PrizrakVpnModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private var pendingCountry: String? = null
  private var pendingPromise: Promise? = null
  private var nodeUp = false

  private val activityListener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(a: Activity?, req: Int, res: Int, data: Intent?) {
      if (req != VPN_REQUEST) return
      if (res == Activity.RESULT_OK) {
        startService(pendingCountry, pendingSocksPort)
        pendingPromise?.resolve(true)
      } else {
        pendingPromise?.reject("denied", "Пользователь не разрешил VPN")
      }
      pendingPromise = null
    }
  }

  init { ctx.addActivityEventListener(activityListener) }

  override fun getName() = "PrizrakVpn"

  private fun emit(event: String, payload: Any?) {
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }

  private var pendingSocksPort: Int = 1080

  private fun startService(country: String?, socksPort: Int) {
    // Параметры (страна/порт/доступ к Банку) сервис читает из prefs (см. enableVpn).
    val i = Intent(ctx, PrizrakVpnService::class.java).apply {
      action = PrizrakVpnService.ACTION_START
    }
    // На Android 8+ сервис с foreground-уведомлением стартуем как foreground —
    // иначе система может кинуть исключение/убить его сразу после запуска.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    emit("vpnState", "up")
  }

  /**
   * Включить маскировку. socksPort — порт локального SOCKS, который уже поднял
   * JS-движок Призрака. При первом запуске система спросит разрешение VpnService.
   */
  @ReactMethod
  fun maskOn(country: String?, socksPort: Int, promise: Promise) {
    // Защита от повторного тапа: пока висит запрос разрешения — не затираем
    // прежний промис (иначе первый вызов зависает навсегда).
    if (pendingPromise != null) { promise.reject("busy", "Запрос разрешения уже идёт"); return }
    pendingCountry = country
    pendingSocksPort = socksPort
    val prepare = try { VpnService.prepare(ctx) } catch (e: Throwable) { null }  // null => разрешение уже есть
    if (prepare == null) { startService(country, socksPort); promise.resolve(true); return }
    val act = currentActivity
    if (act == null) { promise.reject("no_activity", "Откройте приложение и повторите — нет активного окна для запроса разрешения"); return }
    pendingPromise = promise
    try { act.startActivityForResult(prepare, VPN_REQUEST) }
    catch (e: Throwable) { pendingPromise = null; promise.reject("consent_failed", "Не удалось показать окно разрешения VPN: " + e.message) }
  }

  @ReactMethod
  fun maskOff(promise: Promise) {
    val i = Intent(ctx, PrizrakVpnService::class.java).apply { action = PrizrakVpnService.ACTION_STOP }
    ctx.startService(i)
    emit("vpnState", "off")
    promise.resolve(true)
  }

  /** Поднять НАТИВНЫЙ SOCKS5 (Rust data plane) на 127.0.0.1:port по ордеру Банка. */
  @ReactMethod
  fun startNative(
    port: Int,
    relayHost: String, relayPort: Int, relayPub: String,
    exitHost: String, exitPort: Int, exitPub: String,
    orderJson: String, promise: Promise
  ) {
    try {
      PrizrakNative.start(port, relayHost, relayPort, relayPub, exitHost, exitPort, exitPub, orderJson)
      promise.resolve(true)
    } catch (e: Throwable) { promise.reject("native", "нативный движок не запустился: " + e.message) }
  }

  @ReactMethod
  fun stopNative(promise: Promise) {
    try { PrizrakNative.stop() } catch (_: Throwable) {}
    promise.resolve(true)
  }

  /**
   * Включить VPN с ЖИВУЧЕСТЬЮ: сохраняем данные для доступа к Банку, запрашиваем
   * согласие VpnService и стартуем сервис. Дальше сервис САМ добывает ордер,
   * продлевает его и переживает ребут (always-on) — без участия JS.
   */
  @ReactMethod
  fun enableVpn(
    bankUrl: String, userId: String, ghostSeed: String,
    country: String?, socksPort: Int, promise: Promise
  ) {
    PrizrakVpnService.prefs(ctx).edit()
      .putString(PrizrakVpnService.K_BANK, bankUrl)
      .putString(PrizrakVpnService.K_USER, userId)
      .putString(PrizrakVpnService.K_SEED, ghostSeed)
      .putString(PrizrakVpnService.K_COUNTRY, country ?: "")
      .putInt(PrizrakVpnService.K_PORT, socksPort)
      .putBoolean(PrizrakVpnService.K_ENABLED, true)
      .apply()
    maskOn(country, socksPort, promise) // согласие + старт сервиса (ордер добудет сам)
  }

  /** Сменить страну на лету: JS перестраивает маршрут, tun не пересоздаём. */
  @ReactMethod
  fun switchCountry(country: String?, socksPort: Int, promise: Promise) {
    if (!PrizrakVpnService.running) { maskOn(country, socksPort, promise); return }
    startService(country, socksPort)   // ACTION_START с новой страной
    emit("vpnNotice", jsMap("text", "Переключаю на $country"))
    promise.resolve(true)
  }

  /** Поднять/погасить собственный призрак-узел (реле). TODO(поле): фоновая служба реле. */
  @ReactMethod fun nodeOn(promise: Promise) { nodeUp = true; promise.resolve(true) }
  @ReactMethod fun nodeOff(promise: Promise) { nodeUp = false; promise.resolve(true) }

  @ReactMethod
  fun status(promise: Promise) {
    val m: WritableMap = Arguments.createMap()
    m.putString("state", if (PrizrakVpnService.running) "up" else "off")
    m.putString("country", PrizrakVpnService.currentCountry)
    m.putBoolean("node", nodeUp)
    promise.resolve(m)
  }

  private fun jsMap(k: String, v: String): WritableMap =
    Arguments.createMap().apply { putString(k, v) }

  companion object { private const val VPN_REQUEST = 0x7A01 }
}
