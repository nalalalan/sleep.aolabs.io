# Sleep Health Connect Bridge

Android bridge for sending Samsung Health / Galaxy Watch sleep records to `sleep.aolabs.io`.

Download the current debug APK from `https://sleep.aolabs.io/downloads/sleep-bridge.apk`.

## What it does

- Requests Health Connect `READ_SLEEP`.
- Reads completed `SleepSessionRecord` data after wake.
- Posts session timing, source package, and stage intervals to the Sleep API.
- Stores only the endpoint and bridge token locally on the phone.
- Schedules Android background sync automatically after the bridge token and Health Connect permissions are in place.

Samsung Health must be connected to Health Connect first. Watch sleep appears after the watch transfers data to the paired phone and Samsung Health finishes processing it.

## Build

Open this folder in Android Studio. Let Android Studio install or upgrade the Android Gradle Plugin if it asks.

The bridge needs a real Android phone. Health Connect and Samsung Health Data SDK workflows do not work on emulators for Samsung-sourced wearable data.

## Phone setup

1. Samsung Health: Settings -> Health Connect -> enable sharing.
2. Health Connect: allow Samsung Health to write Sleep.
3. Install this bridge on the same Android phone.
4. In the bridge, enter:
   - endpoint: `https://sleep.aolabs.io/api/ingest/sleep-sessions`
   - token: Railway `SLEEP_INGEST_TOKEN`
5. Tap `Grant sleep permission` and include background Health Connect access when Android offers it. The bridge saves the token, schedules background sync, and queues an immediate sync after permission is granted.
6. Leave the bridge installed. Android will periodically check for completed sleep records after Samsung Health writes them to Health Connect.
7. `Sync last 14 days` and `Sync last 60 days` remain available for manual backfill when Samsung Health has a record that has not reached the website yet.

## Notes

Health Connect exposes sleep sessions and stage intervals. Samsung-specific sleep score fields are not part of this bridge. If richer Samsung fields are needed later, use Samsung Health Data SDK access separately and keep the same server ingestion boundary.
