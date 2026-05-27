package io.aolabs.sleepbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

data class SyncResult(
    val accepted: Int,
    val response: String
)

object SleepBridgeSync {
    const val DEFAULT_ENDPOINT = "https://sleep.aolabs.io/api/ingest/sleep-sessions"
    const val PREFS_NAME = "sleep-bridge"
    const val AUTO_WORK_NAME = "sleep-auto-sync"

    val sleepPermission: String = HealthPermission.getReadPermission(SleepSessionRecord::class)
    val backgroundPermission: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    val permissions: Set<String> = setOf(sleepPermission, backgroundPermission)

    fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String =
        prefs(context).getString("endpoint", DEFAULT_ENDPOINT)?.trim().orEmpty().ifBlank { DEFAULT_ENDPOINT }

    fun token(context: Context): String =
        prefs(context).getString("token", "")?.trim().orEmpty()

    fun saveSettings(context: Context, endpoint: String, token: String) {
        prefs(context)
            .edit()
            .putString("endpoint", endpoint.trim().ifBlank { DEFAULT_ENDPOINT })
            .putString("token", token.trim())
            .apply()
    }

    fun scheduleAutoSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val periodic = PeriodicWorkRequestBuilder<SleepSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            AUTO_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodic
        )
    }

    fun queueImmediateSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val oneTime = OneTimeWorkRequestBuilder<SleepSyncWorker>()
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueue(oneTime)
    }

    suspend fun sync(context: Context, days: Int): SyncResult {
        val endpoint = endpoint(context)
        val token = token(context)
        if (endpoint.isBlank() || token.isBlank()) {
            throw IllegalStateException("Endpoint and bridge token required.")
        }

        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            throw IllegalStateException("Health Connect unavailable.")
        }

        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        if (!granted.contains(sleepPermission)) {
            throw IllegalStateException("Sleep permission required.")
        }
        if (!granted.contains(backgroundPermission)) {
            throw IllegalStateException("Background Health Connect permission required.")
        }

        val payload = readSleepPayload(client, days)
        val accepted = payload.getJSONArray("sessions").length()
        if (accepted == 0) {
            return SyncResult(0, "No completed sleep sessions found.")
        }

        return SyncResult(accepted, postPayload(endpoint, token, payload))
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
}
