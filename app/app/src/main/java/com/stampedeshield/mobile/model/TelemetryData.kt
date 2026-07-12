package com.stampedeshield.mobile.model

import org.json.JSONObject

// Per-sensor maximum ADC values — must match app_lab/main.py SENSOR_MAX
private val SENSOR_MAX = listOf(515, 1023, 575, 630, 570, 210)

data class TelemetryData(
    val timestamp: String,
    val sensors: List<Int>,
    val risk: Int,
    val status: String,
    val spcState: String,
    val alert: String,
    val fusionReason: String = "",
    val recommendedAction: String = "",
    val lstmReady: Boolean = false,
    val normalizedLoads: List<Float> = emptyList()
) {
    companion object {
        fun fromJson(jsonStr: String): TelemetryData? {
            return try {
                val json = JSONObject(jsonStr)
                val type = json.optString("type", "")
                if (type != "telemetry" && type != "telemetry_ml") return null

                val sensorsArray = json.optJSONArray("sensors") ?: return null
                val sensorsList = mutableListOf<Int>()
                for (i in 0 until sensorsArray.length()) sensorsList.add(sensorsArray.getInt(i))

                val normLoads = sensorsList.mapIndexed { i, v ->
                    val max = SENSOR_MAX.getOrElse(i) { 1023 }
                    (v.toFloat() / max).coerceIn(0f, 1f)
                }
                val peakNorm = normLoads.maxOrNull() ?: 0f

                var timestampStr = json.optString("timestamp", "")
                if (timestampStr.isEmpty()) {
                    val ts = json.optLong("ts", 0L)
                    if (ts > 0) {
                        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                        timestampStr = sdf.format(java.util.Date(ts))
                    }
                }

                // Check if 4 or more sensors exceed maximum safety load threshold (>= 85%)
                val criticalSensorCount = normLoads.count { it >= 0.85f }

                var riskVal = if (json.has("risk") && !json.isNull("risk"))
                    json.getInt("risk")
                else (peakNorm * 100).toInt().coerceIn(0, 100)

                var statusVal = json.optString("status", "").ifEmpty {
                    when {
                        riskVal >= 70 -> "CRITICAL"
                        riskVal >= 45 -> "HIGH"
                        riskVal >= 20 -> "WATCH"
                        else          -> "SAFE"
                    }
                }
                var spcStateVal = json.optString("spcState", "").ifEmpty {
                    when {
                        riskVal >= 70 -> "Out of Control"
                        riskVal >= 45 -> "Drifting"
                        else          -> "Stable"
                    }
                }
                val fusionReason      = json.optString("fusionReason", "")
                var recommendedAction = json.optString("recommendedAction", "")
                val lstmReady         = json.optBoolean("lstmReady", false)
                var alertVal = json.optString("alert", "").ifEmpty {
                    fusionReason.ifEmpty {
                        when {
                            riskVal >= 70 -> "CRITICAL: Severe crowd compression detected!"
                            riskVal >= 45 -> "HIGH: Elevated pressure — alert marshals."
                            riskVal >= 20 -> "WATCH: Moderate crowd density — monitor."
                            else          -> "System Monitoring — All areas nominal."
                        }
                    }
                }

                // Apply Emergency override if 4 or more sensors attained their max, otherwise suppress alert
                if (criticalSensorCount >= 4) {
                    riskVal = 100
                    statusVal = "CRITICAL"
                    spcStateVal = "Out of Control"
                    alertVal = "CRITICAL EMERGENCY: 4+ sensors exceeded maximum safety threshold!"
                    recommendedAction = "EVACUATE ZONE IMMEDIATELY"
                } else {
                    riskVal = (normLoads.average() * 100).toInt().coerceIn(0, 100)
                    statusVal = "SAFE"
                    spcStateVal = "Stable"
                    alertVal = "System Monitoring — All areas nominal."
                    recommendedAction = "Monitor — no action required"
                }

                TelemetryData(
                    timestamp         = timestampStr,
                    sensors           = sensorsList,
                    risk              = riskVal,
                    status            = statusVal,
                    spcState          = spcStateVal,
                    alert             = alertVal,
                    fusionReason      = fusionReason,
                    recommendedAction = recommendedAction,
                    lstmReady         = lstmReady,
                    normalizedLoads   = normLoads
                )
            } catch (e: Exception) { null }
        }
    }
}
