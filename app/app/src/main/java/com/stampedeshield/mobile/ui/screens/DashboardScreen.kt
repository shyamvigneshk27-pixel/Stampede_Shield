package com.stampedeshield.mobile.ui.screens

import androidx.compose.animation.animateColor
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.stampedeshield.mobile.model.ConnectionState
import com.stampedeshield.mobile.model.TelemetryData
import com.stampedeshield.mobile.ui.components.*

@Composable
fun DashboardScreen(
    connectionState: ConnectionState,
    telemetryData: TelemetryData?,
    vibrationEnabled: Boolean = true
) {
    if (telemetryData == null) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF8FAFC)),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(color = Color(0xFF10B981))
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = "Waiting for Arduino Hardware...",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF64748B)
                )
            }
        }
        return
    }

    val data = telemetryData

    // Show critical overlay whenever status transitions to CRITICAL
    var showCriticalOverlay by remember { mutableStateOf(false) }
    var overlayDismissed by remember { mutableStateOf(false) }

    LaunchedEffect(data.status, data.timestamp) {
        if (data.status.uppercase() == "CRITICAL") {
            overlayDismissed = false
            showCriticalOverlay = true
        } else {
            showCriticalOverlay = false
            overlayDismissed = false
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF8FAFC))
                .padding(16.dp)
        ) {
            // Header
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "StampedeShield",
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Black,
                        color = Color(0xFF1E293B),
                        letterSpacing = 0.5.sp
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        val (statusText, dotColor) = when (connectionState) {
                            ConnectionState.CONNECTED -> Pair("Connected", Color(0xFF10B981))
                            ConnectionState.CONNECTING -> Pair("Connecting...", Color(0xFFF59E0B))
                            ConnectionState.DISCONNECTED -> Pair("Disconnected", Color(0xFFEF4444))
                            ConnectionState.RECONNECTING -> Pair("Reconnecting...", Color(0xFFF59E0B))
                        }
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(dotColor)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Connection Status ($statusText)",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF64748B)
                        )
                    }
                }

                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "LAST UPDATE",
                        fontSize = 9.sp,
                        color = Color(0xFF64748B),
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp
                    )
                    val timeStr = if (data.timestamp.length > 19) {
                        data.timestamp.substring(11, 19)
                    } else {
                        data.timestamp
                    }
                    Text(
                        text = timeStr,
                        fontSize = 14.sp,
                        color = Color(0xFF1E293B),
                        fontWeight = FontWeight.Black
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Scrollable content
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Alert Banner
                AlertBanner(
                    status = data.status,
                    alertMessage = data.alert
                )

                // Risk Indicator Panel
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .shadow(2.dp, RoundedCornerShape(20.dp))
                        .clip(RoundedCornerShape(20.dp))
                        .background(Color.White)
                        .border(1.dp, Color(0xFFF1F5F9), RoundedCornerShape(20.dp))
                        .padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    CircularRiskIndicator(
                        risk = data.risk,
                        modifier = Modifier.size(125.dp)
                    )

                    Spacer(modifier = Modifier.width(20.dp))

                    Column {
                        Text(
                            text = "OVERALL STATUS",
                            fontSize = 11.sp,
                            color = Color(0xFF64748B),
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.sp
                        )
                        val statusColor = when (data.status.uppercase()) {
                            "SAFE" -> Color(0xFF059669)
                            "HIGH", "CRITICAL" -> Color(0xFFDC2626)
                            else -> Color(0xFFD97706)
                        }
                        Text(
                            text = data.status,
                            fontSize = 24.sp,
                            color = statusColor,
                            fontWeight = FontWeight.Black
                        )
                        Spacer(modifier = Modifier.height(12.dp))

                        Text(
                            text = "CONTROL STATE",
                            fontSize = 11.sp,
                            color = Color(0xFF64748B),
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.sp
                        )
                        Text(
                            text = data.spcState.replace("_", " "),
                            fontSize = 16.sp,
                            color = Color(0xFF1E293B),
                            fontWeight = FontWeight.Black
                        )
                    }
                }

                // Status Card Component
                StatusCard()

                // Heatmap Box
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .shadow(2.dp, RoundedCornerShape(20.dp))
                        .clip(RoundedCornerShape(20.dp))
                        .background(Color.White)
                        .border(1.dp, Color(0xFFF1F5F9), RoundedCornerShape(20.dp))
                        .padding(16.dp)
                ) {
                    HeatmapView(sensorValues = data.sensors, normalizedLoads = data.normalizedLoads)
                }

                // Sensor readings
                SensorGrid(sensorValues = data.sensors)

                Spacer(modifier = Modifier.height(16.dp))
            }
        }

        // ── CRITICAL ALERT OVERLAY ──────────────────────────────────────
        if (showCriticalOverlay && !overlayDismissed) {
            CriticalAlertOverlay(
                risk = data.risk,
                alertMessage = data.alert,
                onDismiss = {
                    overlayDismissed = true
                    showCriticalOverlay = false
                }
            )
        }
    }
}

/**
 * Full-screen modal overlay shown when a CRITICAL alert is received.
 * Features a pulsing red background, prominent warning icon, risk score,
 * alert message, and a dismiss button.
 */
@Composable
private fun CriticalAlertOverlay(
    risk: Int,
    alertMessage: String,
    onDismiss: () -> Unit
) {
    val infiniteTransition = rememberInfiniteTransition(label = "CriticalFlash")

    val bgFlash by infiniteTransition.animateColor(
        initialValue = Color(0xFFFF0000).copy(alpha = 0.75f),
        targetValue  = Color(0xFF7F0000).copy(alpha = 0.90f),
        animationSpec = infiniteRepeatable(
            animation = tween(500, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "CriticalBgFlash"
    )

    val iconScale by infiniteTransition.animateFloat(
        initialValue = 1.0f,
        targetValue  = 1.15f,
        animationSpec = infiniteRepeatable(
            animation = tween(400, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "IconPulse"
    )

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            dismissOnBackPress = true,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false
        )
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(bgFlash),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp)
                    .shadow(24.dp, RoundedCornerShape(28.dp))
                    .clip(RoundedCornerShape(28.dp))
                    .background(Color(0xFF1A0000))
                    .border(2.dp, Color(0xFFFF4444), RoundedCornerShape(28.dp))
                    .padding(28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Pulsing warning icon
                Text(
                    text = "🚨",
                    fontSize = (48 * iconScale).sp,
                    textAlign = TextAlign.Center
                )

                // Title
                Text(
                    text = "CRITICAL ALERT",
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Black,
                    color = Color(0xFFFF4444),
                    letterSpacing = 2.sp,
                    textAlign = TextAlign.Center
                )

                // Risk score pill
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xFFFF4444))
                        .padding(horizontal = 24.dp, vertical = 8.dp)
                ) {
                    Text(
                        text = "RISK LEVEL: $risk%",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Black,
                        color = Color.White,
                        letterSpacing = 1.sp
                    )
                }

                // Divider
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(Color(0xFF7F1D1D))
                )

                // Alert message
                Text(
                    text = alertMessage,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color(0xFFFFCDD2),
                    textAlign = TextAlign.Center,
                    lineHeight = 22.sp
                )

                Text(
                    text = "⚠️ Immediate action required!\nEvacuate the area immediately.",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFFFFA0A0),
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp
                )

                Spacer(modifier = Modifier.height(4.dp))

                // Dismiss button
                Button(
                    onClick = onDismiss,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFFEF4444)
                    )
                ) {
                    Text(
                        text = "✓  ACKNOWLEDGE & DISMISS",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 0.5.sp,
                        color = Color.White
                    )
                }
            }
        }
    }
}
