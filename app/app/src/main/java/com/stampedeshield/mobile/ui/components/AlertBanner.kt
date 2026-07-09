package com.stampedeshield.mobile.ui.components

import androidx.compose.animation.animateColor
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AlertBanner(
    status: String,
    alertMessage: String,
    modifier: Modifier = Modifier
) {
    val isEmergency = status.uppercase() == "HIGH" || status.uppercase() == "CRITICAL"

    if (isEmergency) {
        val infiniteTransition = rememberInfiniteTransition(label = "FlashTransition")
        
        val flashColor by infiniteTransition.animateColor(
            initialValue = Color(0xFFFEE2E2),
            targetValue = Color(0xFFFCA5A5),
            animationSpec = infiniteRepeatable(
                animation = tween(600, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse
            ),
            label = "AlertBgFlash"
        )

        Row(
            modifier = modifier
                .fillMaxWidth()
                .shadow(2.dp, RoundedCornerShape(16.dp))
                .clip(RoundedCornerShape(16.dp))
                .background(flashColor)
                .border(1.5.dp, Color(0xFFEF4444), RoundedCornerShape(16.dp))
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "⚠️",
                fontSize = 26.sp,
                modifier = Modifier.padding(end = 12.dp)
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "EMERGENCY: $status ALERT",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Black,
                    color = Color(0xFF991B1B)
                )
                if (alertMessage.isNotBlank()) {
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = alertMessage,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF7F1D1D)
                    )
                }
            }
        }
    } else {
        Row(
            modifier = modifier
                .fillMaxWidth()
                .shadow(2.dp, RoundedCornerShape(16.dp))
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xFFE6F4EA))
                .border(1.dp, Color(0xFFB7E1CD), RoundedCornerShape(16.dp))
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "🛡️",
                fontSize = 26.sp,
                modifier = Modifier.padding(end = 12.dp)
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "System Monitoring...",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Black,
                    color = Color(0xFF137333)
                )
                if (alertMessage.isNotBlank() && alertMessage != "System Monitoring...") {
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = alertMessage,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color(0xFF137333).copy(alpha = 0.8f)
                    )
                }
            }
        }
    }
}
