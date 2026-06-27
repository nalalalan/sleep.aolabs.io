# sleep.aolabs.io

Sleep is an AO Labs sleep-hours API populated from Samsung Health through Health Connect.

The standalone Sleep website is hidden. The root route redirects to `https://blood.aolabs.io/`, where sleep appears with glucose, HR, HRV, recent steps, and the personal anxiety estimate. Keep the Sleep API and downloads available for old bridge installs and Blood's sleep fallback. Writing records still requires the bridge ingest token.

Android bridge download: `https://sleep.aolabs.io/downloads/sleep-bridge.apk`

Current Android bridge: `0.3.0`. It reschedules automatic sync after phone boot or bridge app update and uses a 35-day automatic lookback so missed background runs can heal.

## Data path

Samsung Health on the paired phone writes completed Galaxy Watch sleep to Health Connect after the watch data has transferred and processed. The Android bridge in `connectors/health-connect-bridge` requests Health Connect sleep permission, reads `SleepSessionRecord` records, and posts timing plus stage intervals to the Sleep API.

The website itself cannot directly read Samsung Health or the watch. It only reads the Sleep API and polls the public summary route while the record page is open.

Current API: `https://sleep.aolabs.io`

## Local

```powershell
npm install
$env:SLEEP_INGEST_TOKEN = "local-ingest-token"
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

Public. Used by the website on any device.

`GET /api/sleep/export`

Authorization: `Bearer $SLEEP_READ_TOKEN` when raw export access is needed.

## Railway

Set these variables on the Railway service:

- `SLEEP_INGEST_TOKEN`
- `SLEEP_READ_TOKEN` only for raw export access; the website summary is public.
- `SLEEP_ALLOWED_ORIGINS=https://sleep.aolabs.io,https://aolabs.io,https://sleep-web-production.up.railway.app`
- `DATABASE_URL` from a Railway Postgres service, or `DATA_DIR=/data` with a persistent volume

Use Postgres or a persistent volume for real nightly history. Plain filesystem storage is only safe for local development.
