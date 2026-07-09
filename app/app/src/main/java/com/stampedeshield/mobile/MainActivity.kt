package com.stampedeshield.mobile

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.stampedeshield.mobile.ui.screens.DashboardScreen
import com.stampedeshield.mobile.ui.screens.SettingsScreen
import com.stampedeshield.mobile.viewmodel.MainViewModel

class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            var currentScreen by remember { mutableStateOf("dashboard") }

            val connectionState by viewModel.connectionState.collectAsState()
            val telemetryData by viewModel.telemetryData.collectAsState()
            val serverIp by viewModel.serverIp.collectAsState()
            val vibrationEnabled by viewModel.vibrationEnabled.collectAsState()

            // Trigger vibration when status becomes CRITICAL
            LaunchedEffect(telemetryData?.status) {
                if (telemetryData?.status?.uppercase() == "CRITICAL" && vibrationEnabled) {
                    triggerCriticalVibration(this@MainActivity)
                }
            }

            Scaffold(
                bottomBar = {
                    NavigationBar(
                        containerColor = Color.White,
                        contentColor = Color(0xFF1E293B)
                    ) {
                        NavigationBarItem(
                            selected = currentScreen == "dashboard",
                            onClick = { currentScreen = "dashboard" },
                            icon = { Text("📊", style = MaterialTheme.typography.titleLarge) },
                            label = { Text("Dashboard") },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Color(0xFF10B981),
                                selectedTextColor = Color(0xFF10B981),
                                unselectedIconColor = Color(0xFF64748B),
                                unselectedTextColor = Color(0xFF64748B),
                                indicatorColor = Color(0xFFF1F5F9)
                            )
                        )
                        NavigationBarItem(
                            selected = currentScreen == "settings",
                            onClick = { currentScreen = "settings" },
                            icon = { Text("⚙️", style = MaterialTheme.typography.titleLarge) },
                            label = { Text("Settings") },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Color(0xFF10B981),
                                selectedTextColor = Color(0xFF10B981),
                                unselectedIconColor = Color(0xFF64748B),
                                unselectedTextColor = Color(0xFF64748B),
                                indicatorColor = Color(0xFFF1F5F9)
                            )
                        )
                    }
                }
            ) { paddingValues ->
                Surface(
                    modifier = Modifier.padding(paddingValues),
                    color = Color(0xFFF8FAFC)
                ) {
                    when (currentScreen) {
                        "dashboard" -> {
                            DashboardScreen(
                                connectionState = connectionState,
                                telemetryData = telemetryData,
                                vibrationEnabled = vibrationEnabled
                            )
                        }
                        "settings" -> {
                            SettingsScreen(
                                connectionState = connectionState,
                                initialServerIp = serverIp,
                                vibrationEnabled = vibrationEnabled,
                                onServerIpChanged = { viewModel.saveServerIp(it) },
                                onVibrationEnabledChanged = { viewModel.saveVibrationEnabled(it) },
                                onConnect = { viewModel.connect() },
                                onDisconnect = { viewModel.disconnect() }
                            )
                        }
                    }
                }
            }
        }
    }

    /**
     * Vibrates the device for 10 seconds at maximum intensity (strong vibration)
     * to alert the user of a CRITICAL crowd compression event.
     */
    private fun triggerCriticalVibration(context: Context) {
        val durationMs = 10000L
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            val vibrator = vibratorManager.defaultVibrator
            vibrator.vibrate(VibrationEffect.createOneShot(durationMs, 255))
        } else {
            @Suppress("DEPRECATION")
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(durationMs, 255))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(durationMs)
            }
        }
    }
}
