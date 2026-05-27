package io.aolabs.sleepbridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.temporal.ChronoUnit

class MainActivity : ComponentActivity() {
    private val healthConnectProviderPackage = "com.google.android.apps.healthdata"
    private val permissions = SleepBridgeSync.permissions
    private val requestPermissions = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        if (granted.contains(SleepBridgeSync.sleepPermission)) {
            if (granted.contains(SleepBridgeSync.backgroundPermission)) {
                ensureAutoSync("Sleep permission granted. Auto sync scheduled.")
            } else {
                setStatus("Sleep permission granted. Background sync permission still missing.")
            }
        } else {
            setStatus("Sleep permission not granted.")
        }
    }

    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        loadSettings()
        checkAvailability()
        if (SleepBridgeSync.token(this).isNotBlank()) {
            ensureAutoSync("Auto sync scheduled from saved bridge token.")
        }
    }

    private fun buildUi(): View {
        val padding = (18 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        root.addView(TextView(this).apply {
            text = "Sleep Bridge"
            textSize = 28f
        })

        root.addView(TextView(this).apply {
            text = "Reads completed Health Connect sleep sessions and sends them to sleep.aolabs.io automatically after setup."
            textSize = 15f
            setPadding(0, padding / 2, 0, padding)
        })

        endpointInput = EditText(this).apply {
            hint = "endpoint"
            setSingleLine(true)
            setText(SleepBridgeSync.DEFAULT_ENDPOINT)
        }
        root.addView(endpointInput)

        tokenInput = EditText(this).apply {
            hint = "bridge token"
            setSingleLine(true)
        }
        root.addView(tokenInput)

        root.addView(Button(this).apply {
            text = "Grant sleep permission"
            setOnClickListener {
                saveSettings()
                requestPermissions.launch(permissions)
            }
        })

        root.addView(Button(this).apply {
            text = "Sync last 14 days"
            setOnClickListener { syncSleep(days = 14) }
        })

        root.addView(Button(this).apply {
            text = "Sync last 60 days"
            setOnClickListener { syncSleep(days = 60) }
        })

        statusText = TextView(this).apply {
            text = "Waiting."
            textSize = 14f
            setPadding(0, padding, 0, 0)
        }
        root.addView(statusText)

        return ScrollView(this).apply { addView(root) }
    }

    private fun loadSettings() {
        val prefs = SleepBridgeSync.prefs(this)
        endpointInput.setText(prefs.getString("endpoint", endpointInput.text.toString()))
        tokenInput.setText(prefs.getString("token", ""))
    }

    private fun saveSettings() {
        SleepBridgeSync.saveSettings(
            this,
            endpointInput.text.toString().trim(),
            tokenInput.text.toString().trim()
        )
    }

    private fun ensureAutoSync(message: String, queueImmediate: Boolean = true): Boolean {
        saveSettings()
        if (SleepBridgeSync.token(this).isBlank()) {
            setStatus("Bridge token required before auto sync can run.")
            return false
        }
        SleepBridgeSync.scheduleAutoSync(this)
        if (queueImmediate) {
            SleepBridgeSync.queueImmediateSync(this)
        }
        setStatus(message)
        return true
    }

    private fun checkAvailability() {
        val status = HealthConnectClient.getSdkStatus(this)
        when (status) {
            HealthConnectClient.SDK_AVAILABLE -> setStatus("Health Connect available.")
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                setStatus("Health Connect update required.")
                val uri = Uri.parse("market://details?id=$healthConnectProviderPackage")
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
            else -> setStatus("Health Connect unavailable on this phone.")
        }
    }

    private fun syncSleep(days: Int) {
        saveSettings()
        val endpoint = endpointInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Endpoint and bridge token required.")
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Checking Health Connect permission.")
            val client = HealthConnectClient.getOrCreate(this@MainActivity)
            val granted = client.permissionController.getGrantedPermissions()
            if (!granted.contains(SleepBridgeSync.sleepPermission)) {
                setStatus("Sleep permission required.")
                requestPermissions.launch(permissions)
                return@launch
            }
            if (!granted.contains(SleepBridgeSync.backgroundPermission)) {
                requestPermissions.launch(permissions)
            }
            ensureAutoSync(
                "Auto sync scheduled. Android will check periodically after Samsung Health writes sleep to Health Connect.",
                queueImmediate = false
            )

            try {
                val payload = withContext(Dispatchers.IO) { readSleepPayload(client, days) }
                val accepted = payload.getJSONArray("sessions").length()
                if (accepted == 0) {
                    setStatus("No completed sleep sessions found in the selected window.")
                    return@launch
                }

                setStatus("Sending $accepted sleep session(s).")
                val response = withContext(Dispatchers.IO) { postPayload(endpoint, token, payload) }
                ensureAutoSync("Manual sync accepted. Auto sync is scheduled for future nights.", queueImmediate = false)
                setStatus(response)
            } catch (error: Exception) {
                setStatus("Sync failed: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    private suspend fun readSleepPayload(client: HealthConnectClient, days: Int): JSONObject {
        val end = Instant.now().plus(1, ChronoUnit.DAYS)
        val start = Instant.now().minus(days.toLong() + 1, ChronoUnit.DAYS)
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end)
            )
        )

        val sessions = JSONArray()
        for (record in response.records) {
            sessions.put(recordToJson(record))
        }

        return JSONObject()
            .put("source", "health-connect")
            .put("capturedAt", Instant.now().toString())
            .put("sessions", sessions)
    }

    private fun recordToJson(record: SleepSessionRecord): JSONObject {
        val stages = JSONArray()
        for (stage in record.stages) {
            stages.put(
                JSONObject()
                    .put("stage", stageName(stage.stage))
                    .put("startTime", stage.startTime.toString())
                    .put("endTime", stage.endTime.toString())
            )
        }

        return JSONObject()
            .put("sessionId", record.metadata.id)
            .put("clientRecordId", record.metadata.clientRecordId ?: record.metadata.id)
            .put("sourcePackage", record.metadata.dataOrigin.packageName)
            .put("title", record.title ?: "Sleep")
            .put("notes", record.notes ?: "")
            .put("startTime", record.startTime.toString())
            .put("endTime", record.endTime.toString())
            .put("startZoneOffset", record.startZoneOffset?.id ?: "")
            .put("endZoneOffset", record.endZoneOffset?.id ?: "")
            .put("stages", stages)
    }

    private fun stageName(stage: Int): String {
        return when (stage) {
            SleepSessionRecord.STAGE_TYPE_AWAKE -> "AWAKE"
            SleepSessionRecord.STAGE_TYPE_SLEEPING -> "SLEEPING"
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "OUT_OF_BED"
            SleepSessionRecord.STAGE_TYPE_LIGHT -> "LIGHT"
            SleepSessionRecord.STAGE_TYPE_DEEP -> "DEEP"
            SleepSessionRecord.STAGE_TYPE_REM -> "REM"
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "AWAKE_IN_BED"
            else -> "UNKNOWN"
        }
    }

    private fun postPayload(endpoint: String, token: String, payload: JSONObject): String {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }

        connection.outputStream.use { stream ->
            stream.write(payload.toString().toByteArray(Charsets.UTF_8))
        }

        val code = connection.responseCode
        val body = (if (code in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()
            ?.use { it.readText() }
            .orEmpty()

        if (code !in 200..299) {
            throw IllegalStateException("API $code $body")
        }

        return "Sync accepted by Sleep API. $body"
    }

    private fun setStatus(message: String) {
        statusText.text = message
    }
}
