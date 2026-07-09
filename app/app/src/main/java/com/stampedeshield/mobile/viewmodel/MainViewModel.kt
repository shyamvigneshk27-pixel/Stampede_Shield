package com.stampedeshield.mobile.viewmodel

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.stampedeshield.mobile.data.ConnectionRepository
import com.stampedeshield.mobile.model.ConnectionState
import com.stampedeshield.mobile.model.TelemetryData
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val sharedPrefs = application.getSharedPreferences("stampede_shield_prefs", Context.MODE_PRIVATE)
    private val repository = ConnectionRepository()

    private val _serverIp = MutableStateFlow(sharedPrefs.getString("server_ip", "") ?: "")
    val serverIp = _serverIp.asStateFlow()

    private val _vibrationEnabled = MutableStateFlow(sharedPrefs.getBoolean("vibration_enabled", true))
    val vibrationEnabled = _vibrationEnabled.asStateFlow()

    // Connection state flow from repository
    val connectionState: StateFlow<ConnectionState> = repository.connectionState

    private val _telemetryData = MutableStateFlow<TelemetryData?>(null)
    val telemetryData = _telemetryData.asStateFlow()

    init {
        // Collect live telemetry from the repository.
        // When a packet arrives, update the UI flow.
        // When disconnected, the last received value stays visible.
        viewModelScope.launch {
            repository.telemetryData.collect { data ->
                if (data != null) {
                    _telemetryData.value = data
                }
            }
        }
    }

    fun saveServerIp(ip: String) {
        _serverIp.value = ip
        sharedPrefs.edit().putString("server_ip", ip).apply()
    }

    fun saveVibrationEnabled(enabled: Boolean) {
        _vibrationEnabled.value = enabled
        sharedPrefs.edit().putBoolean("vibration_enabled", enabled).apply()
    }

    fun connect() {
        val ip = _serverIp.value
        if (ip.isNotBlank()) {
            repository.connect(ip)
        }
    }

    fun disconnect() {
        repository.disconnect()
    }
}
