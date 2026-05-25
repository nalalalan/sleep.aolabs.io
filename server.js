const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const cors = require("cors");
const express = require("express");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3051", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = process.env.SLEEP_DATA_FILE || path.join(DATA_DIR, "sleep-sessions.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_STORED_SESSIONS = Number.parseInt(process.env.SLEEP_MAX_SESSIONS || "730", 10);
const DEFAULT_ALLOWED_ORIGINS = [
  "https://sleep.aolabs.io",
  "https://aolabs.io",
  "http://127.0.0.1:3051",
  "http://localhost:3051"
];

const STAGE_NAMES = new Set([
  "UNKNOWN",
  "AWAKE",
  "SLEEPING",
  "OUT_OF_BED",
  "AWAKE_IN_BED",
  "LIGHT",
  "DEEP",
  "REM"
]);

let pgPoolPromise = null;
let dbReadyPromise = null;

function allowedOrigins() {
  const configured = (process.env.SLEEP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (process.env.SLEEP_ALLOW_ALL_ORIGINS === "1") return true;
  return allowedOrigins().has(origin);
}

app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));

function extractToken(req) {
  const authorization = req.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return (
    bearer?.[1] ||
    req.get("x-sleep-token") ||
    req.get("x-sleep-ingest-token") ||
    req.query.token ||
    ""
  ).trim();
}

function requireConfiguredToken(envName, purpose) {
  return (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) {
      res.status(503).json({
        ok: false,
        error: "token_not_configured",
        purpose
      });
      return;
    }

    const actual = extractToken(req);
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    const matches = expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer);

    if (!matches) {
      res.status(401).json({
        ok: false,
        error: "unauthorized",
        purpose
      });
      return;
    }

    next();
  };
}

function maybeRequireReadToken(req, res, next) {
  if (!process.env.SLEEP_READ_TOKEN) {
    next();
    return;
  }
  requireConfiguredToken("SLEEP_READ_TOKEN", "read")(req, res, next);
}

function parseTime(value, field) {
  const time = new Date(value);
  if (!value || Number.isNaN(time.getTime())) {
    const error = new Error(`invalid_${field}`);
    error.status = 400;
    throw error;
  }
  return time.toISOString();
}

function offsetMinutes(offset) {
  const match = String(offset || "").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3], 10));
}

function sleepDateFromEnd(endTime, endZoneOffset) {
  const time = new Date(endTime).getTime();
  const shifted = new Date(time + offsetMinutes(endZoneOffset) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function stageName(stage) {
  const normalized = String(stage || "UNKNOWN").toUpperCase().replace(/[^A-Z_]/g, "_");
  return STAGE_NAMES.has(normalized) ? normalized : "UNKNOWN";
}

function stableSessionId(session) {
  const basis = [
    session.sessionId,
    session.clientRecordId,
    session.sourcePackage,
    session.startTime,
    session.endTime
  ].filter(Boolean).join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function sanitizeSession(session, capturedAt, source) {
  if (!session || typeof session !== "object") {
    const error = new Error("invalid_session");
    error.status = 400;
    throw error;
  }

  const startTime = parseTime(session.startTime, "start_time");
  const endTime = parseTime(session.endTime, "end_time");
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (durationMs <= 0 || durationMs > 36 * 60 * 60 * 1000) {
    const error = new Error("invalid_sleep_duration");
    error.status = 400;
    throw error;
  }

  const sanitized = {
    sessionId: stableSessionId({ ...session, startTime, endTime }),
    clientRecordId: String(session.clientRecordId || session.sessionId || "").slice(0, 160),
    source: String(source || "health-connect").slice(0, 80),
    sourcePackage: String(session.sourcePackage || "").slice(0, 160),
    title: String(session.title || "Sleep").slice(0, 120),
    notes: session.notes ? String(session.notes).slice(0, 240) : "",
    startTime,
    endTime,
    startZoneOffset: String(session.startZoneOffset || session.zoneOffset || "").slice(0, 12),
    endZoneOffset: String(session.endZoneOffset || session.zoneOffset || "").slice(0, 12),
    capturedAt,
    stages: []
  };

  sanitized.sleepDate = sleepDateFromEnd(sanitized.endTime, sanitized.endZoneOffset);

  if (Array.isArray(session.stages)) {
    sanitized.stages = session.stages.map((stage) => ({
      stage: stageName(stage.stage || stage.type),
      startTime: parseTime(stage.startTime, "stage_start_time"),
      endTime: parseTime(stage.endTime, "stage_end_time")
    })).filter((stage) => new Date(stage.endTime).getTime() > new Date(stage.startTime).getTime());
  }

  return sanitized;
}

function sanitizePayload(payload) {
  const capturedAt = parseTime(payload?.capturedAt || new Date().toISOString(), "captured_at");
  const source = payload?.source || "health-connect";
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  if (!sessions.length) {
    const error = new Error("no_sessions");
    error.status = 400;
    throw error;
  }
  if (sessions.length > 60) {
    const error = new Error("too_many_sessions");
    error.status = 400;
    throw error;
  }
  return sessions.map((session) => sanitizeSession(session, capturedAt, source));
}

async function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPoolPromise) {
    pgPoolPromise = import("pg").then(({ Pool }) => new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) || process.env.PGSSLMODE === "disable"
        ? false
        : { rejectUnauthorized: false }
    }));
  }
  return pgPoolPromise;
}

async function ensureDb() {
  const pool = await getPgPool();
  if (!pool) return;
  if (!dbReadyPromise) {
    dbReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS sleep_sessions (
        session_id TEXT PRIMARY KEY,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sleep_sessions_end_time_idx ON sleep_sessions (end_time DESC);
    `);
  }
  await dbReadyPromise;
}

async function readJsonSessions() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonSessions(sessions) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({
    updatedAt: new Date().toISOString(),
    sessions
  }, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

async function readSessions() {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const result = await pool.query(
      "SELECT payload FROM sleep_sessions ORDER BY end_time DESC LIMIT $1",
      [MAX_STORED_SESSIONS]
    );
    return result.rows.map((row) => row.payload);
  }
  return readJsonSessions();
}

async function storeSessions(sessions) {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const session of sessions) {
        await client.query(`
          INSERT INTO sleep_sessions (session_id, start_time, end_time, captured_at, payload, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
          ON CONFLICT (session_id)
          DO UPDATE SET
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            captured_at = EXCLUDED.captured_at,
            payload = EXCLUDED.payload,
            updated_at = now()
        `, [session.sessionId, session.startTime, session.endTime, session.capturedAt, session]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const existing = await readJsonSessions();
  const byId = new Map(existing.map((session) => [session.sessionId, session]));
  for (const session of sessions) byId.set(session.sessionId, session);
  const next = Array.from(byId.values())
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())
    .slice(0, MAX_STORED_SESSIONS);
  await writeJsonSessions(next);
}

function minutesBetween(startTime, endTime) {
  return Math.max(0, Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60_000));
}

function stageMinutes(session) {
  const totals = {
    awake: 0,
    light: 0,
    deep: 0,
    rem: 0,
    sleeping: 0,
    unknown: 0,
    outOfBed: 0
  };

  for (const stage of session.stages || []) {
    const minutes = minutesBetween(stage.startTime, stage.endTime);
    if (stage.stage === "AWAKE" || stage.stage === "AWAKE_IN_BED") totals.awake += minutes;
    else if (stage.stage === "OUT_OF_BED") totals.outOfBed += minutes;
    else if (stage.stage === "LIGHT") totals.light += minutes;
    else if (stage.stage === "DEEP") totals.deep += minutes;
    else if (stage.stage === "REM") totals.rem += minutes;
    else if (stage.stage === "SLEEPING") totals.sleeping += minutes;
    else totals.unknown += minutes;
  }

  return totals;
}

function summarizeSessions(sessions) {
  const normalized = sessions
    .filter((session) => session?.startTime && session?.endTime)
    .map((session) => {
      const durationMinutes = minutesBetween(session.startTime, session.endTime);
      const stages = stageMinutes(session);
      const awakeMinutes = stages.awake + stages.outOfBed;
      return {
        sessionId: session.sessionId,
        sleepDate: session.sleepDate || sleepDateFromEnd(session.endTime, session.endZoneOffset),
        startTime: session.startTime,
        endTime: session.endTime,
        startZoneOffset: session.startZoneOffset,
        endZoneOffset: session.endZoneOffset,
        durationMinutes,
        asleepMinutes: Math.max(0, durationMinutes - awakeMinutes),
        awakeMinutes,
        stageMinutes: stages,
        source: session.source || "health-connect",
        sourcePackage: session.sourcePackage || "",
        capturedAt: session.capturedAt || null
      };
    })
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());

  if (!normalized.length) {
    return {
      ok: true,
      status: "waiting_for_health_connect",
      recordCount: 0,
      generatedAt: new Date().toISOString(),
      latest: null,
      nights: [],
      trend: [],
      message: "No Health Connect sleep records yet."
    };
  }

  const nightMap = new Map();
  for (const session of normalized) {
    const night = nightMap.get(session.sleepDate) || {
      sleepDate: session.sleepDate,
      sessions: 0,
      durationMinutes: 0,
      asleepMinutes: 0,
      awakeMinutes: 0,
      stageMinutes: {
        awake: 0,
        light: 0,
        deep: 0,
        rem: 0,
        sleeping: 0,
        unknown: 0,
        outOfBed: 0
      },
      startTime: session.startTime,
      endTime: session.endTime,
      sourcePackage: session.sourcePackage,
      capturedAt: session.capturedAt
    };
    night.sessions += 1;
    night.durationMinutes += session.durationMinutes;
    night.asleepMinutes += session.asleepMinutes;
    night.awakeMinutes += session.awakeMinutes;
    for (const [key, value] of Object.entries(session.stageMinutes)) {
      night.stageMinutes[key] += value;
    }
    if (new Date(session.startTime).getTime() < new Date(night.startTime).getTime()) {
      night.startTime = session.startTime;
    }
    if (new Date(session.endTime).getTime() > new Date(night.endTime).getTime()) {
      night.endTime = session.endTime;
      night.sourcePackage = session.sourcePackage;
      night.capturedAt = session.capturedAt;
    }
    nightMap.set(session.sleepDate, night);
  }

  const nightsDesc = Array.from(nightMap.values())
    .sort((a, b) => b.sleepDate.localeCompare(a.sleepDate));
  const recentSeven = nightsDesc.slice(0, 7);
  const averageDurationMinutes = Math.round(
    recentSeven.reduce((sum, night) => sum + night.durationMinutes, 0) / Math.max(1, recentSeven.length)
  );
  const averageAsleepMinutes = Math.round(
    recentSeven.reduce((sum, night) => sum + night.asleepMinutes, 0) / Math.max(1, recentSeven.length)
  );

  return {
    ok: true,
    status: "connected",
    generatedAt: new Date().toISOString(),
    recordCount: normalized.length,
    nightCount: nightsDesc.length,
    latest: nightsDesc[0],
    averageDurationMinutes,
    averageAsleepMinutes,
    lastCapturedAt: normalized
      .map((session) => session.capturedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    nights: nightsDesc.slice(0, 14),
    trend: nightsDesc.slice(0, 30).reverse()
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "sleep-aolabs",
    generatedAt: new Date().toISOString(),
    storage: DATABASE_URL ? "postgres" : "json-file",
    ingestionTokenConfigured: Boolean(process.env.SLEEP_INGEST_TOKEN),
    readTokenConfigured: Boolean(process.env.SLEEP_READ_TOKEN)
  });
});

app.get("/api/sleep/summary", maybeRequireReadToken, async (_req, res, next) => {
  try {
    res.json(summarizeSessions(await readSessions()));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sleep/export", maybeRequireReadToken, async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      sessions: await readSessions()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ingest/sleep-sessions", requireConfiguredToken("SLEEP_INGEST_TOKEN", "ingest"), async (req, res, next) => {
  try {
    const sessions = sanitizePayload(req.body);
    await storeSessions(sessions);
    res.json({
      ok: true,
      accepted: sessions.length,
      sessionIds: sessions.map((session) => session.sessionId)
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(__dirname, {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "5m" : 0,
  etag: true
}));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  next();
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: status >= 500 ? "server_error" : error.message,
    message: status >= 500 ? "Sleep API error." : error.message
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`sleep.aolabs.io listening on ${PORT}`);
  });
}

module.exports = {
  app,
  sanitizePayload,
  summarizeSessions
};
