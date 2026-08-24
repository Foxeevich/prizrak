package com.prizrakmobile.vpn

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * PrizrakOrders — получение подписанного ордера у Банка БЕЗ участия JS.
 * Нужно для always-on: VpnService сам подписывает запрос ghost-ключом (натив,
 * Ed25519) и тянет свежий ордер (реле+выход). Тело подписи = ровно то, что шлём.
 */
object PrizrakOrders {

    data class Chain(
        val relayHost: String, val relayPort: Int, val relayPub: String,
        val exitHost: String, val exitPort: Int, val exitPub: String,
        val orderJson: String, val country: String, val paidUntil: Long
    )

    private fun randHex(n: Int): String {
        val b = ByteArray(n); SecureRandom().nextBytes(b)
        val sb = StringBuilder(n * 2)
        for (x in b) sb.append(String.format("%02x", x))
        return sb.toString()
    }

    /** Сходить в Банк за ордером. null — если сеть/оплата/узлы недоступны. */
    fun fetch(bankUrl: String, userId: String, ghostSeed: String, country: String): Chain? {
        try {
            val ts = System.currentTimeMillis() / 1000
            val nonce = randHex(8)
            // Тело подписываем и отправляем БАЙТ-В-БАЙТ одинаково (Банк проверяет
            // подпись над сырым телом). Порядок полей не важен — важна идентичность.
            val body = JSONObject()
                .put("country", country)
                .put("userId", userId)
                .put("ts", ts)
                .put("nonce", nonce)
                .toString()
            val sig = PrizrakNative.sign(ghostSeed, body)
            if (sig.isEmpty()) return null

            val url = URL(bankUrl.trimEnd('/') + "/api/vpn/connect")
            val c = url.openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = 10000
            c.readTimeout = 15000
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("x-sig", sig)
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val resp = stream?.bufferedReader()?.use { it.readText() } ?: return null
            if (code !in 200..299) return null

            val j = JSONObject(resp)
            val order = j.optJSONObject("order") ?: return null
            val relay = order.getJSONObject("relay")
            val exit = order.getJSONObject("exit")
            return Chain(
                relay.getString("host"), relay.getInt("port"), relay.getString("pub"),
                exit.getString("host"), exit.getInt("port"), exit.getString("pub"),
                order.toString(),                       // ордер целиком для LINK (Банк переподпишет проверку по полям)
                order.optString("country", country),
                j.optLong("paidUntil", 0L)
            )
        } catch (_: Throwable) {
            return null
        }
    }
}
