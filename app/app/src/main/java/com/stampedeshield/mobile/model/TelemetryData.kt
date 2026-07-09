package com.stampedeshield.mobile.model

import org.json.JSONObject

data class TelemetryData(
    val timestamp: String,
    val sensors: List<Int>,
    val risk: Int,
    val status: String,
    val spcState: String,
    val alert: String
) {
    companion object {
        fun fromJson(jsonStr: String): TelemetryData {
            val json = JSONObject(jsonStr)
            val sensorsArray = json.getJSONArray("sensors")
            val sensorsList = mutableListOf<Int>()
            for (i in 0 until sensorsArray.length()) {
                sensorsList.add(sensorsArray.getInt(i))
            }

            var timestampStr = json.optString("timestamp", "")
            if (timestampStr.isEmpty() && json.has("ts")) {
                val ts = json.optLong("ts", 0L)
                if (ts > 0) {
                    val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                    timestampStr = sdf.format(java.util.Date(ts))
                } else {
                    timestampStr = json.optString("ts", "")
                }
            }

            val riskVal = if (json.has("risk")) {
                json.getInt("risk")
            } else if (sensorsList.isNotEmpty()) {
                val maxVal = sensorsList.maxOrNull() ?: 0
                ((maxVal / 1023.0) * 100).toInt().coerceIn(0, 100)
            } else {
                0
            }

            val statusVal = if (json.has("status")) {
                json.getString("status")
            } else {
                when {
                    riskVal >= 75 -> "CRITICAL"
                    riskVal >= 50 -> "HIGH"
                    riskVal >= 25 -> "WARNING"
                    else -> "SAFE"
                }
            }

            val spcStateVal = if (json.has("spcState")) {
                json.getString("spcState")
            } else {
                when {
                    riskVal >= 75 -> "OUT_OF_CONTROL"
                    riskVal >= 50 -> "WARNING_STATE"
                    else -> "NORMAL"
                }
            }

            val alertVal = if (json.has("alert")) {
                json.getString("alert")
            } else {
                when {
                    riskVal >= 75 -> "CRITICAL: Severe crowd pressure detected!"
                    riskVal >= 50 -> "HIGH: High crowd density observed."
                    riskVal >= 25 -> "WARNING: Moderate crowd pressure."
                    else -> "System Monitoring - All areas normal"
                }
            }

            return TelemetryData(
                timestamp = timestampStr,
                sensors = sensorsList,
                risk = riskVal,
                status = statusVal,
                spcState = spcStateVal,
                alert = alertVal
            )
        }
    }
}
