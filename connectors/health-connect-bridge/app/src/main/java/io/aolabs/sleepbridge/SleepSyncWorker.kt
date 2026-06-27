package io.aolabs.sleepbridge

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.time.Instant

class SleepSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        if (!SleepBridgeSync.hasToken(applicationContext)) {
            saveStatus("Auto sync waiting for bridge token.")
            return Result.success()
        }

        return try {
            val result = SleepBridgeSync.sync(applicationContext, days = SleepBridgeSync.AUTO_SYNC_LOOKBACK_DAYS)
            saveStatus("Auto sync ${Instant.now()}: ${result.accepted} session(s).")
            Result.success()
        } catch (error: Exception) {
            val message = error.message ?: error.javaClass.simpleName
            saveStatus("Auto sync failed ${Instant.now()}: $message")
            if (message.contains("permission", ignoreCase = true) ||
                message.contains("token", ignoreCase = true) ||
                message.contains("unavailable", ignoreCase = true)
            ) {
                Result.success()
            } else {
                Result.retry()
            }
        }
    }

    private fun saveStatus(message: String) {
        SleepBridgeSync.saveAutoStatus(applicationContext, message)
    }
}
