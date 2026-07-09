package com.stampedeshield.mobile.data

import android.util.Log
import com.stampedeshield.mobile.model.ConnectionState
import com.stampedeshield.mobile.model.TelemetryData
import com.stampedeshield.mobile.network.WebSocketManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ConnectionRepository {

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _telemetryData = MutableStateFlow<TelemetryData?>(null)
    val telemetryData: StateFlow<TelemetryData?> = _telemetryData.asStateFlow()

    private var webSocketManager: WebSocketManager? = null
    private var serverUrl: String? = null
    private var isManualDisconnect = false

    private val repositoryScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null

    private val webSocketListener = object : WebSocketManager.WebSocketListener {
        override fun onConnected() {
            Log.d("WebSocket", "Connected")
            _connectionState.value = ConnectionState.CONNECTED
            startHeartbeat()
        }

        override fun onDisconnected(reason: String) {
            Log.d("WebSocket", "Disconnected")
            _connectionState.value = ConnectionState.DISCONNECTED
            stopHeartbeat()
            if (!isManualDisconnect) {
                scheduleReconnect()
            }
        }

        override fun onMessageReceived(text: String) {
            try {
                val json = org.json.JSONObject(text)
                if (json.optString("type") == "telemetry") {
                    val data = TelemetryData.fromJson(text)
                    _telemetryData.value = data
                }
            } catch (e: Exception) {
                Log.e("ConnectionRepository", "Failed to parse telemetry: ${e.message}")
            }
        }

        override fun onError(t: Throwable) {
            Log.d("WebSocket", "Disconnected")
            _connectionState.value = ConnectionState.DISCONNECTED
            stopHeartbeat()
            if (!isManualDisconnect) {
                scheduleReconnect()
            }
        }
    }

    init {
        webSocketManager = WebSocketManager(webSocketListener)
    }

    fun connect(ipAddress: String) {
        isManualDisconnect = false
        val cleanIp = ipAddress.trim()
        // Format URL using ws protocol and fixed 8080 port internally
        val url = if (cleanIp.startsWith("ws://") || cleanIp.startsWith("wss://")) {
            val cleanUrl = cleanIp.removePrefix("ws://").removePrefix("wss://").substringBefore("/")
            val ipOnly = cleanUrl.substringBefore(":")
            "ws://$ipOnly:8080"
        } else {
            "ws://$cleanIp:8080"
        }

        serverUrl = url
        Log.d("WebSocket", "Connecting...")
        _connectionState.value = ConnectionState.CONNECTING
        
        reconnectJob?.cancel()
        webSocketManager?.connect(url)
    }

    fun disconnect() {
        isManualDisconnect = true
        reconnectJob?.cancel()
        stopHeartbeat()
        Log.d("WebSocket", "Disconnected")
        _connectionState.value = ConnectionState.DISCONNECTED
        webSocketManager?.disconnect()
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = repositoryScope.launch {
            while (isActive) {
                delay(5000)
                try {
                    val heartbeatJson = "{\"type\":\"heartbeat\",\"device\":\"Android\"}"
                    webSocketManager?.send(heartbeatJson)
                } catch (e: Exception) {
                    Log.e("ConnectionRepository", "Failed to send heartbeat: ${e.message}")
                }
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = repositoryScope.launch {
            delay(3000)
            val url = serverUrl
            if (url != null && !isManualDisconnect) {
                Log.d("WebSocket", "Reconnecting...")
                _connectionState.value = ConnectionState.RECONNECTING
                webSocketManager?.connect(url)
            }
        }
    }
}
