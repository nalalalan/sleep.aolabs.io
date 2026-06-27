package io.aolabs.sleepbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reason = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> "phone boot"
            Intent.ACTION_MY_PACKAGE_REPLACED -> "bridge update"
            else -> return
        }
        SleepBridgeSync.ensureAutoSyncFromSystem(context, reason)
    }
}
