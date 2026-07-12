package com.stampedeshield.mobile.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun HeatmapView(
    sensorValues: List<Int>,
    normalizedLoads: List<Float> = emptyList(),
    modifier: Modifier = Modifier
) {
    val values = if (sensorValues.size >= 6) sensorValues else listOf(0, 0, 0, 0, 0, 0)
    // Use pre-computed normalized loads if provided, else fallback to raw/1023
    val sensorMax = listOf(515f, 1023f, 575f, 630f, 570f, 210f)
    val norms = if (normalizedLoads.size >= 6) normalizedLoads
                else values.mapIndexed { i, v -> (v.toFloat() / sensorMax[i]).coerceIn(0f, 1f) }

    // Animate normalized loads for smooth color transitions
    val animatedSensors = List(6) { index ->
        animateFloatAsState(
            targetValue = norms[index],
            animationSpec = tween(durationMillis = 600, easing = LinearOutSlowInEasing),
            label = "SensorHeat_$index"
        )
    }

    // Coordinates for 2x3 layout as normalized floats
    val positions = listOf(
        Offset(0.20f, 0.30f), // F1
        Offset(0.50f, 0.30f), // F2
        Offset(0.80f, 0.30f), // F3
        Offset(0.20f, 0.70f), // F4
        Offset(0.50f, 0.70f), // F5
        Offset(0.80f, 0.70f)  // F6
    )

    Column(modifier = modifier) {
        Text(
            text = "PRESSURE HEATMAP",
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF64748B),
            letterSpacing = 1.2.sp,
            modifier = Modifier.padding(bottom = 12.dp)
        )

        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color.White)
                .border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(16.dp))
        ) {
            val canvasWidth = maxWidth
            val canvasHeight = maxHeight

            // Draw Thermal Pressure Heatmap on Canvas using IDW (Inverse Distance Weighting)
            Canvas(modifier = Modifier.fillMaxSize()) {
                val cols = 40
                val rows = 20
                val cellWidth = size.width / cols
                val cellHeight = size.height / rows

                // Optimization: Pre-calculate current sensor values
                val currentVals = FloatArray(6) { i -> animatedSensors[i].value }

                for (row in 0 until rows) {
                    val ny = (row + 0.5f) / rows
                    for (col in 0 until cols) {
                        val nx = (col + 0.5f) / cols

                        var weightSum = 0f
                        var valueSum = 0f

                        for (i in 0 until 6) {
                            val dx = nx - positions[i].x
                            val dy = ny - positions[i].y
                            var distSq = dx * dx + dy * dy
                            if (distSq < 0.001f) distSq = 0.001f
                            // IDW with power of 4 for localized but continuous blobs
                            val weight = 1f / (distSq * distSq)
                            weightSum += weight
                            valueSum += currentVals[i] * weight
                        }

                        val interpolatedValue = valueSum / weightSum
                        // Already normalized 0..1 — use directly for color
                        val intensity = interpolatedValue.coerceIn(0f, 1f)
                        val color = getHeatColor(intensity)

                        drawRect(
                            color = color,
                            topLeft = Offset(col * cellWidth, row * cellHeight),
                            size = Size(cellWidth + 1f, cellHeight + 1f) // +1f to prevent 1px aliasing gaps
                        )
                    }
                }
            }

            // Draw sensor markers and labels
            positions.forEachIndexed { i, pos ->
                val xDp = (pos.x * canvasWidth.value).dp
                val yDp = (pos.y * canvasHeight.value).dp

                Box(
                    modifier = Modifier
                        .offset(x = xDp - 20.dp, y = yDp - 25.dp)
                        .size(40.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(Color.White)
                                .border(1.5.dp, Color(0xFF1E293B), CircleShape)
                        )
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            text = "F${i + 1}",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Black,
                            color = Color(0xFF1E293B)
                        )
                    }
                }
            }
        }
    }
}

// Thermal pressure color gradient mapping: Green -> Yellow -> Orange -> Red
private fun getHeatColor(intensity: Float): Color {
    val safeColor = Color(0xFF10B981)     // Green
    val watchColor = Color(0xFFF59E0B)    // Yellow
    val highColor = Color(0xFFF97316)     // Orange
    val criticalColor = Color(0xFFEF4444) // Red

    return when {
        intensity < 0.25f -> lerpColor(safeColor, watchColor, intensity / 0.25f)
        intensity < 0.50f -> lerpColor(watchColor, highColor, (intensity - 0.25f) / 0.25f)
        intensity < 0.75f -> lerpColor(highColor, criticalColor, (intensity - 0.50f) / 0.25f)
        else -> lerpColor(criticalColor, criticalColor, 1f)
    }
}

private fun lerpColor(start: Color, end: Color, fraction: Float): Color {
    val f = fraction.coerceIn(0f, 1f)
    return Color(
        red = start.red + (end.red - start.red) * f,
        green = start.green + (end.green - start.green) * f,
        blue = start.blue + (end.blue - start.blue) * f,
        alpha = start.alpha + (end.alpha - start.alpha) * f
    )
}
