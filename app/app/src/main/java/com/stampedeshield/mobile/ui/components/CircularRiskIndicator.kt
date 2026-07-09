package com.stampedeshield.mobile.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun CircularRiskIndicator(
    risk: Int,
    modifier: Modifier = Modifier
) {
    val animatedRisk by animateFloatAsState(
        targetValue = risk.toFloat(),
        animationSpec = tween(durationMillis = 1000, easing = FastOutSlowInEasing),
        label = "RiskAnimation"
    )

    // Pulsing effect for warning glow
    val infiniteTransition = rememberInfiniteTransition(label = "GlowTransition")
    val pulseAlpha by infiniteTransition.animateFloat(
        initialValue = 0.2f,
        targetValue = 0.7f,
        animationSpec = infiniteRepeatable(
            animation = tween(1200, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "GlowPulse"
    )

    // Color gradient based on risk level
    val startColor = when {
        risk < 30 -> Color(0xFF10B981) // Safe Emerald Green
        risk < 60 -> Color(0xFFF59E0B) // Watch Amber/Yellow
        else -> Color(0xFFEF4444) // Emergency Red
    }
    val endColor = when {
        risk < 30 -> Color(0xFF3B82F6) // Safe Cool Blue
        risk < 60 -> Color(0xFFD97706) // Watch Dark Amber
        else -> Color(0xFFB91C1C) // Emergency Dark Red
    }

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.size(180.dp)
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val strokeWidth = 12.dp.toPx()
            val innerSize = size.minDimension - strokeWidth
            
            // Draw background track (Clean light gray)
            drawCircle(
                color = Color(0xFFE2E8F0),
                radius = innerSize / 2,
                style = Stroke(width = strokeWidth)
            )

            // Draw glowing outline for warning/danger
            if (risk >= 60) {
                drawArc(
                    brush = Brush.sweepGradient(listOf(startColor, endColor, startColor)),
                    startAngle = -90f,
                    sweepAngle = (animatedRisk / 100f) * 360f,
                    useCenter = false,
                    style = Stroke(width = strokeWidth * 1.4f, cap = StrokeCap.Round),
                    alpha = pulseAlpha
                )
            }

            // Draw active indicator arc
            drawArc(
                brush = Brush.sweepGradient(listOf(startColor, endColor, startColor)),
                startAngle = -90f,
                sweepAngle = (animatedRisk / 100f) * 360f,
                useCenter = false,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
            )
        }

        // Center Labels (High Contrast Dark Mode Text)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "${animatedRisk.toInt()}%",
                fontSize = 36.sp,
                fontWeight = FontWeight.Black,
                color = Color(0xFF1E293B)
            )
            Spacer(modifier = Modifier.height(2.dp))
            val riskLabel = when {
                risk < 30 -> "SAFE"
                risk < 60 -> "WATCH"
                risk < 80 -> "HIGH"
                else -> "CRITICAL"
            }
            val labelColor = when (riskLabel) {
                "SAFE" -> Color(0xFF059669) // Emerald
                "WATCH" -> Color(0xFFD97706) // Amber
                "HIGH" -> Color(0xFFDC2626) // Red
                else -> Color(0xFF991B1B) // Critical Dark Red
            }
            Text(
                text = riskLabel,
                fontSize = 15.sp,
                fontWeight = FontWeight.Black,
                color = labelColor
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = "RISK INDEX",
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                color = Color(0xFF64748B),
                letterSpacing = 1.sp
            )
        }
    }
}
