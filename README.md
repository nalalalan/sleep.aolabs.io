# sleep.aolabs.io

Sleep is an AO Labs private sleep record populated from Samsung Health through Health Connect, with a secondary low-stimulation transition surface.

The sleep record is the root surface at `/`. It only reads completed sleep sessions that a consented Android bridge sends after wake. The transition surface remains available at `/#transition`.

Android bridge download: `https://sleep.aolabs.io/downloads/sleep-bridge.apk`

## Data path

Samsung Health on the paired phone writes completed Galaxy Watch sleep to Health Connect after the watch data has transferred and processed. The Android bridge in `connectors/health-connect-bridge` requests Health Connect sleep permission, reads `SleepSessionRecord` records, and posts timing plus stage intervals to the Sleep API.

The website itself cannot directly read Samsung Health or the watch. It only reads the Sleep API.

Current API: `https://sleep.aolabs.io`

## Local

```powershell
npm install
$env:SLEEP_INGEST_TOKEN = "local-ingest-token"
$env:SLEEP_READ_TOKEN = "local-read-token"
npm run dev
```

Then open `http://127.0.0.1:3051/`.

## API

`POST /api/ingest/sleep-sessions`

Authorization: `Bearer $SLEEP_INGEST_TOKEN`

```json
{
  "source": "health-connect",
  "capturedAt": "2026-05-25T10:00:00.000Z",
  "sessions": [
    {
      "clientRecordId": "health-connect-record-id",
      "sourcePackage": "com.sec.android.app.shealth",
      "startTime": "2026-05-24T03:12:00.000Z",
      "endTime": "2026-05-24T10:34:00.000Z",
      "startZoneOffset": "-04:00",
      "endZoneOffset": "-04:00",
      "stages": [
        { "stage": "LIGHT", "startTime": "2026-05-24T03:12:00.000Z", "endTime": "2026-05-24T04:20:00.000Z" }
      ]
    }
  ]
}
```

`GET /api/sleep/summary`

Authorization: `Bearer $SLEEP_READ_TOKEN` when the read token is configured.

## Railway

Set these variables on the Railway service:

- `SLEEP_INGEST_TOKEN`
- `SLEEP_READ_TOKEN`
- `SLEEP_ALLOWED_ORIGINS=https://sleep.aolabs.io,https://aolabs.io,https://sleep-web-production.up.railway.app`
- `DATABASE_URL` from a Railway Postgres service, or `DATA_DIR=/data` with a persistent volume

Use Postgres or a persistent volume for real nightly history. Plain filesystem storage is only safe for local development.
