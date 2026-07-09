package com.stampedeshield.mobile.network

import okhttp3.*
import okio.ByteString

class WebSocketManager(
    private val listener: WebSocketListener
) {
    interface WebSocketListener {
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onMessageReceived(text: String)
        fun onError(t: Throwable)
    }

    private val client = OkHttpClient()
    private var webSocket: WebSocket? = null

    fun connect(serverUrl: String) {
        // Cancel any active websocket before starting a new one
        disconnect()

        val request = Request.Builder()
            .url(serverUrl)
            .build()
        
        webSocket = client.newWebSocket(request, object : okhttp3.WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onConnected()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessageReceived(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                listener.onMessageReceived(bytes.utf8())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onDisconnected(reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onError(t)
            }
        })
    }

    fun send(text: String): Boolean {
        return webSocket?.send(text) ?: false
    }

    fun disconnect() {
        try {
            webSocket?.close(1000, "Disconnect requested")
        } catch (e: Exception) {
            // Safe closing
        }
        webSocket = null
    }
}
