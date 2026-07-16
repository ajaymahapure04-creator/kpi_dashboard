import express from "express";
import cors from "cors";
import { DBSQLClient } from "@databricks/sql";
import dotenv from "dotenv";
import http from "http";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { createRequire } from "module";
import { LOCAL_DATA_DIR, loadLocalDataRows, loadLocalDashboardSnapshot, generateLocalJsonFilesFromCsvs } from './scripts/local-data-utils.mjs';

const require = createRequire(import.meta.url);
const { Server: WebSocketServer } = require("ws");

dotenv.config();

// Default to Europe Databricks SQL endpoint for the prod connection when
// environment variables are not provided. These values can be overridden
// via the environment or a .env file in development.
process.env.DATABRICKS_HOST = process.env.DATABRICKS_HOST || process.env.DATABRICKS_HOST_EU || 'adb-7805820729597748.8.azuredatabricks.net';
process.env.DATABRICKS_PATH = process.env.DATABRICKS_PATH || process.env.DATABRICKS_PATH_EU || '/sql/protocolv1/o/7805820729597748/0219-115735-wrabeaqw';
process.env.DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN_EU;
process.env.DATALAKE_PROD_SCHEMA = process.env.DATALAKE_PROD_SCHEMA || 'hive_metastore.datalake_prod';
// NA / INT / USCA endpoint defaults (used for North America / integration environment)
process.env.DATABRICKS_INT_HOST = process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_HOST_INT || 'adb-1839209099868758.18.azuredatabricks.net';
process.env.DATABRICKS_INT_PATH = process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_PATH_INT || '/sql/1.0/warehouses/ed4e4be35f5ac2b2';
process.env.DATABRICKS_INT_TOKEN = process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_TOKEN_INT;
process.env.DATALAKE_INT_SCHEMA = process.env.DATALAKE_INT_SCHEMA || 'hive_metastore.datalake_int';

// Local data mode: when no Databricks token is configured (or LOCAL_DATA=1),
// serve rows from data/*.json when available, falling back to data/*.csv.
// CSV remains the source/export format for compatibility, and JSON is treated
// as a fast local cache generated from CSVs. LOCAL_DATA=0 forces off.
// DATA_MODE=live|local is the preferred explicit switch for development —
// it takes priority over LOCAL_DATA and the token-presence auto-detection.
// Assigning undefined to process.env (the default lines above) stores the
// literal string "undefined", so treat that as an absent token here.
const hasDatabricksToken = [process.env.DATABRICKS_TOKEN, process.env.DATABRICKS_INT_TOKEN]
  .some((t) => t && t !== 'undefined');
const DATA_MODE_ENV = (process.env.DATA_MODE || '').trim().toLowerCase();
const LOCAL_DATA_MODE = DATA_MODE_ENV === 'local'
  ? true
  : DATA_MODE_ENV === 'live'
  ? false
  : process.env.LOCAL_DATA === '1'
  || (process.env.LOCAL_DATA !== '0' && !hasDatabricksToken);

const localDataCache = new Map();
function loadLocalRows(name) {
  return loadLocalDataRows(name, localDataCache);
}

// Every API route maps onto one of the 8 canonical CSVs — each file is
// already the full EU + US/CA + NAR/CN combination.
const LOCAL_ENDPOINT_ALIASES = {
  fact_main_oru4_prod: 'fact_main',
  fact_main_combined: 'fact_main',
  fact_main_eu_usca_combined: 'fact_main',
  fact_adoption_rate_combined: 'fact_adoption_rate',
  fact_adoption_rate_eu_usca_combined: 'fact_adoption_rate',
  fact_ecu_combined: 'fact_ecu',
  fact_ecu_eu_combined: 'fact_ecu',
  fact_targeted_vehicles_combined: 'fact_targeted_vehicles',
  fact_targeted_vehicles_eu_usca_combined: 'fact_targeted_vehicles',
  fact_release_combined: 'fact_release',
  fact_release_eu_usca_combined: 'fact_release',
  dim_campaign_combined: 'dim_campaign',
  dim_campaign_eu_usca_narch_combined: 'dim_campaign',
  dim_country_combined: 'dim_country',
  dim_country_eu_usca_narch_combined: 'dim_country',
};

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Lets the frontend show a Live/Local connection indicator without
// guessing — reflects the mode decided once at process startup, not a
// continuous health check (switching modes requires a backend restart).
app.get('/api/status', (req, res) => {
  res.json({ mode: LOCAL_DATA_MODE ? 'local' : 'live' });
});

// Serialize once, gzip once, and send with the right Content-Encoding when
// the client accepts it. The dashboard snapshot is large (dimension rows plus
// aggregated facts), highly repetitive JSON, so gzip typically shrinks it ~10x
// — the single biggest lever on perceived load time in local mode.
function sendJsonMaybeGzip(req, res, payload) {
  // `payload` may be a raw JSON string or a { gzip } pair carrying a
  // pre-computed gzip buffer (used for the cached local snapshot so we never
  // re-compress ~300 MB per request).
  const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof payload === 'string') {
    if (accepts) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(zlib.gzipSync(payload));
    }
    return res.end(payload);
  }
  if (accepts) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.end(payload.gzip);
  }
  // Client doesn't accept gzip: only real-world case is non-browser tooling.
  // Rebuilding the multi-hundred-MB plain string here can hit the same V8
  // string-length ceiling the buffer-based build was written to avoid, so
  // this is a deliberate, clearly-labeled failure rather than a crash.
  res.status(415);
  return res.end(JSON.stringify({ error: 'Response only available gzip-encoded for datasets this large; request with Accept-Encoding: gzip.' }));
}

// V8 caps a single JS string well under ~1 GB, but Buffer.concat has no such
// ceiling — so a JSON array is built as a sequence of small stringified
// batches, each converted to a Buffer immediately, instead of ever forming
// one giant string. This is what buildLocalSnapshot's plain JSON.stringify
// used to do, and why it could throw "RangeError: Invalid string length"
// once the real (non-mock) dataset grew large enough.
const JSON_ARRAY_BATCH_SIZE = 2000;
function jsonArrayBuffer(rows) {
  const parts = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < rows.length; i += JSON_ARRAY_BATCH_SIZE) {
    const batch = rows.slice(i, i + JSON_ARRAY_BATCH_SIZE);
    const inner = JSON.stringify(batch).slice(1, -1); // strip batch's own [ ]
    if (!inner) continue;
    if (parts.length > 1) parts.push(Buffer.from(',', 'utf8'));
    parts.push(Buffer.from(inner, 'utf8'));
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

// Builds the core dashboard snapshot response (everything the Overview and
// KPI Detail pages need) as a Buffer, never a single JS string, by
// concatenating each field's Buffer. fact_main and fact_main_enriched are
// byte-identical, so the same Buffer is reused rather than built twice.
// fact_release/fact_adoption_rate are deliberately NOT included here — they
// stay row-level (not aggregated like fact_main) and only the DLCM Release
// Statistics/Comparison pages need them, so they ship on their own endpoint
// (see buildDlcmBuffer) fetched lazily only when a user opens those pages.
// Bundling everything into one payload is what made a real-scale dataset
// (500K+ aggregated fact_main rows plus proportionally larger release/
// adoption tables) big enough to crash the browser tab outright once it
// finally reached the frontend (see the Overview/DLCM split in App.jsx).
function buildSnapshotBuffer({ mode, factMainAgg, adoptionAgg, campaignRows, countryRows, aiRows, filterOptions }) {
  const factMainBuf = jsonArrayBuffer(factMainAgg);
  return Buffer.concat([
    Buffer.from(`{"mode":${JSON.stringify(mode)}`, 'utf8'),
    Buffer.from(',"fact_main":', 'utf8'), factMainBuf,
    Buffer.from(',"fact_main_enriched":', 'utf8'), factMainBuf,
    Buffer.from(',"fact_adoption_rate_agg":', 'utf8'), jsonArrayBuffer(adoptionAgg || []),
    Buffer.from(',"dim_campaign":', 'utf8'), jsonArrayBuffer(campaignRows),
    Buffer.from(',"dim_country":', 'utf8'), jsonArrayBuffer(countryRows),
    Buffer.from(',"fact_ai_summaries_latest":', 'utf8'), Buffer.from(JSON.stringify(aiRows), 'utf8'),
    Buffer.from(',"filter_options":', 'utf8'), Buffer.from(JSON.stringify(filterOptions), 'utf8'),
    Buffer.from('}', 'utf8'),
  ]);
}

// Same Buffer-not-string approach for the DLCM-only payload (fact_release +
// fact_adoption_rate, row-level and enriched).
function buildDlcmBuffer({ mode, releaseEnriched, adoptionEnriched }) {
  const releaseBuf = jsonArrayBuffer(releaseEnriched);
  const adoptionBuf = jsonArrayBuffer(adoptionEnriched);
  return Buffer.concat([
    Buffer.from(`{"mode":${JSON.stringify(mode)}`, 'utf8'),
    Buffer.from(',"fact_release":', 'utf8'), releaseBuf,
    Buffer.from(',"fact_release_enriched":', 'utf8'), releaseBuf,
    Buffer.from(',"fact_adoption_rate":', 'utf8'), adoptionBuf,
    Buffer.from(',"fact_adoption_rate_enriched":', 'utf8'), adoptionBuf,
    Buffer.from('}', 'utf8'),
  ]);
}

// In local mode the underlying files never change while the process is up, so
// the core snapshot (aggregated fact_main + dimensions + gzip bytes) is built
// once and reused. This turns every page load after the first into an instant
// buffer write instead of re-reading/re-aggregating hundreds of MB of JSON.
// Built eagerly at startup (see buildLocalSnapshot() call below) so the slow
// aggregation happens once at boot instead of blocking whichever browser
// request happens to arrive first.
let localSnapshotJsonCache = null;
// The DLCM payload (fact_release/fact_adoption_rate) is built lazily on
// first request, not pre-warmed — most sessions never open those pages, so
// there's no reason to pay that cost (or hold that memory) at every boot.
let localDlcmSnapshotCache = null;

function buildLocalSnapshot() {
  const snapshot = loadLocalDashboardSnapshot(localDataCache);
  const factMainRows = Array.isArray(snapshot.fact_main) ? snapshot.fact_main : [];
  const adoptionRows = Array.isArray(snapshot.fact_adoption_rate) ? snapshot.fact_adoption_rate : [];
  const campaignRows = Array.isArray(snapshot.dim_campaign) ? snapshot.dim_campaign : [];
  const countryRows = Array.isArray(snapshot.dim_country) ? snapshot.dim_country : [];
  const aiRows = Array.isArray(snapshot.fact_ai_summaries_latest) ? snapshot.fact_ai_summaries_latest : [];

  // fact_main is aggregated to a compact cube; the browser reconstructs
  // every KPI/series/delta from the pre-summed components (see App.jsx
  // valueForKpi). fact_adoption_rate gets the same treatment so the Adoption
  // Rate KPI is available immediately, without waiting for the lazy
  // /api/dlcm_snapshot fetch.
  const factMainAgg = buildFactMainAggregate(factMainRows, campaignRows, countryRows);
  const adoptionAgg = buildAdoptionRateAggregate(adoptionRows, campaignRows, countryRows);
  const filterOptions = buildDashboardFilterCatalog(factMainAgg, campaignRows, countryRows);

  const buf = buildSnapshotBuffer({ mode: 'local', factMainAgg, adoptionAgg, campaignRows, countryRows, aiRows, filterOptions });
  localSnapshotJsonCache = { gzip: zlib.gzipSync(buf) };
  console.log(`Local snapshot built: fact_main ${factMainRows.length} rows -> ${factMainAgg.length} aggregated cube rows, fact_adoption_rate ${adoptionRows.length} rows -> ${adoptionAgg.length} aggregated cube rows (${(localSnapshotJsonCache.gzip.length / 1e6).toFixed(1)} MB gzipped).`);
  return localSnapshotJsonCache;
}

function buildLocalDlcmSnapshot() {
  const snapshot = loadLocalDashboardSnapshot(localDataCache);
  const campaignRows = Array.isArray(snapshot.dim_campaign) ? snapshot.dim_campaign : [];
  const countryRows = Array.isArray(snapshot.dim_country) ? snapshot.dim_country : [];
  const releaseRows = Array.isArray(snapshot.fact_release) ? snapshot.fact_release : [];
  const adoptionRows = Array.isArray(snapshot.fact_adoption_rate) ? snapshot.fact_adoption_rate : [];

  const releaseEnriched = enrichFactRows(releaseRows, campaignRows, countryRows);
  const adoptionEnriched = enrichFactRows(adoptionRows, campaignRows, countryRows);

  const buf = buildDlcmBuffer({ mode: 'local', releaseEnriched, adoptionEnriched });
  localDlcmSnapshotCache = { gzip: zlib.gzipSync(buf) };
  console.log(`Local DLCM snapshot built: fact_release ${releaseEnriched.length} rows, fact_adoption_rate ${adoptionEnriched.length} rows (${(localDlcmSnapshotCache.gzip.length / 1e6).toFixed(1)} MB gzipped).`);
  return localDlcmSnapshotCache;
}

app.get('/api/dashboard_snapshot', async (req, res) => {
  try {
    if (LOCAL_DATA_MODE) {
      if (!localSnapshotJsonCache) buildLocalSnapshot();
      return sendJsonMaybeGzip(req, res, localSnapshotJsonCache);
    }

    const [factMainRows, adoptionRows, campaignRows, countryRows, aiRows] = await Promise.all([
      queryFactMainCombined(0, true),
      queryFactAdoptionRateCombined(0),
      queryDimCampaignCombined(0),
      queryDimCountryCombined(0),
      queryAiSummariesLatest(0),
    ]);

    const factMainEnriched = enrichFactRows(factMainRows, campaignRows, countryRows);
    const adoptionAgg = buildAdoptionRateAggregate(adoptionRows, campaignRows, countryRows);
    const filterOptions = buildDashboardFilterCatalog(factMainRows, campaignRows, countryRows);

    const buf = buildSnapshotBuffer({
      mode: 'live', factMainAgg: factMainEnriched, adoptionAgg, campaignRows, countryRows, aiRows, filterOptions,
    });
    return sendJsonMaybeGzip(req, res, { gzip: zlib.gzipSync(buf) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// Row-level fact_release/fact_adoption_rate, fetched only when a user opens
// a DLCM Release page — see the comment on buildSnapshotBuffer for why this
// isn't part of /api/dashboard_snapshot.
app.get('/api/dlcm_snapshot', async (req, res) => {
  try {
    if (LOCAL_DATA_MODE) {
      if (!localDlcmSnapshotCache) buildLocalDlcmSnapshot();
      return sendJsonMaybeGzip(req, res, localDlcmSnapshotCache);
    }

    const [campaignRows, countryRows, releaseRows, adoptionRows] = await Promise.all([
      queryDimCampaignCombined(0),
      queryDimCountryCombined(0),
      queryFactReleaseCombined(0),
      queryFactAdoptionRateCombined(0),
    ]);

    const releaseEnriched = enrichFactRows(releaseRows, campaignRows, countryRows);
    const adoptionEnriched = enrichFactRows(adoptionRows, campaignRows, countryRows);

    const buf = buildDlcmBuffer({ mode: 'live', releaseEnriched, adoptionEnriched });
    return sendJsonMaybeGzip(req, res, { gzip: zlib.gzipSync(buf) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

if (LOCAL_DATA_MODE) {
  console.log(`Local data mode: serving rows from ${LOCAL_DATA_DIR} (no Databricks connection). JSON snapshots are preferred; CSV files are still supported.`);
  generateLocalJsonFilesFromCsvs();
  // Pre-warm the aggregated snapshot now, before the port opens, so the
  // one-time aggregation cost lands at boot instead of stalling the first
  // browser to load the dashboard. Failures here must not crash the
  // server — fall back to the old lazy build-on-first-request behavior
  // (still inside the /api/dashboard_snapshot try/catch) so a bad local
  // data file degrades to a 500 on that one route instead of taking the
  // whole backend down.
  console.log('Pre-warming local dashboard snapshot (this can take a while for large datasets)...');
  const warmupStartedAt = Date.now();
  try {
    buildLocalSnapshot();
    console.log(`Snapshot pre-warm finished in ${((Date.now() - warmupStartedAt) / 1000).toFixed(1)}s.`);
  } catch (error) {
    console.error('Snapshot pre-warm failed, will retry lazily on first request:', error);
  }
  app.use('/api', (req, res, next) => {
    const name = req.path.replace(/^\/+/, '');
    if (name === 'table_counts') {
      const counts = {};
      const files = fs.existsSync(LOCAL_DATA_DIR) ? fs.readdirSync(LOCAL_DATA_DIR) : [];
      for (const file of files) {
        if (!file.endsWith('.csv') && !file.endsWith('.json')) continue;
        const base = file.replace(/\.csv$/, '').replace(/\.json$/, '');
        const rows = loadLocalRows(base) || [];
        counts[base] = [{ table: base, row_count: rows.length }];
      }
      return res.json(counts);
    }
    const rows = loadLocalRows(LOCAL_ENDPOINT_ALIASES[name] || name);
    if (!rows) return next();
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    return res.json(limit > 0 ? rows.slice(0, limit) : rows);
  });
}

// In-memory cache and SSE clients for live updates
// Default refresh every 10 minutes: fact_main is now fetched unlimited (the
// full table, not a 1000-row sample), so refreshing every 15s would hammer
// the Databricks warehouse with a full-table scan four times a minute.
// Override with CACHE_REFRESH_INTERVAL_MS.
const CACHE_REFRESH_INTERVAL_MS = Number(process.env.CACHE_REFRESH_INTERVAL_MS) || 10 * 60 * 1000;
const cache = {
  fact_main: { rows: [], updatedAt: 0 },
};

const sseClients = new Set();
let wss; // defined when server starts

function broadcastFactMainUpdate(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // ignore write errors; client will be cleaned up on close
    }
  }
}

function broadcastWebSocket(payloadObj) {
  if (!wss) return;
  const msg = JSON.stringify(payloadObj);
  for (const client of wss.clients) {
    try {
      if (client && client.readyState === 1) client.send(msg);
    } catch (e) {
      // ignore send errors
    }
  }
}

async function refreshFactMainCache() {
  if (LOCAL_DATA_MODE) {
    // Local files are static for the life of the process and the browser
    // already receives the aggregated fact_main via /api/dashboard_snapshot.
    // Broadcasting the full ~1M raw rows over WebSocket here would (a) load
    // and hold the entire raw table in memory a second time and (b) overwrite
    // the browser's compact aggregate with raw rows the frontend can't
    // aggregate. So there is nothing to stream in local mode — no-op.
    return;
  }
  try {
    const rows = await queryFactMainCombined(0); // 0 = unlimited, full table
    const now = Date.now();
    const prev = cache.fact_main.rows || [];

    // Build maps by id for prev and new
    const prevMap = new Map(prev.map((r) => [makeRowId(r), JSON.stringify(r)]));
    const newMapRows = new Map(rows.map((r) => [makeRowId(r), r]));

    const added = [];
    const updated = [];
    const removed = [];

    for (const [id, newRow] of newMapRows.entries()) {
      if (!prevMap.has(id)) {
        added.push(newRow);
      } else {
        const prevJson = prevMap.get(id);
        const newJson = JSON.stringify(newRow);
        if (prevJson !== newJson) updated.push(newRow);
        // remove from prevMap so remaining entries are deletions
        prevMap.delete(id);
      }
    }

    for (const id of prevMap.keys()) removed.push(id);

    cache.fact_main.rows = rows;
    cache.fact_main.updatedAt = now;

    // If this is the first cache population (no prev), send full snapshot
    if (!prev || prev.length === 0) {
      const payload = { full: true, rows, updatedAt: now };
      broadcastFactMainUpdate(payload);
      broadcastWebSocket(payload);
    } else {
      // Send only deltas
      const payload = { full: false, added, updated, removed, updatedAt: now };
      broadcastFactMainUpdate(payload);
      broadcastWebSocket(payload);
    }
  } catch (err) {
    console.error('Error refreshing fact_main cache', err && err.message ? err.message : String(err));
  }
}

// start periodic cache refresh
setImmediate(refreshFactMainCache);
setInterval(refreshFactMainCache, CACHE_REFRESH_INTERVAL_MS);

const PROD_SCHEMA = process.env.DATALAKE_PROD_SCHEMA || 'hive_metastore.datalake_prod';
const INT_SCHEMA = process.env.DATALAKE_INT_SCHEMA || 'hive_metastore.datalake_int';
const DEV_SCHEMA = process.env.DATALAKE_DEV_SCHEMA || 'hive_metastore.datalake_dev';

function databricksClient() {
  return new DBSQLClient();
}

function getDatabricksConfig(connection = 'prod') {
  switch (connection) {
    case 'int':
      return {
        host: process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST,
        path: process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH,
        token: process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN,
      };
    case 'usca':
      return {
        host: process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST,
        path: process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH,
        token: process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN,
      };
    default:
      return {
        host: process.env.DATABRICKS_HOST || process.env.DATABRICKS_HOST_EU,
        path: process.env.DATABRICKS_PATH || process.env.DATABRICKS_PATH_EU,
        token: process.env.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN_EU,
      };
  }
}

async function openDatabricksSession(connection = 'prod') {
  const config = getDatabricksConfig(connection);
  const client = databricksClient();
  try {
    await client.connect({
      host: config.host,
      path: config.path,
      token: config.token,
      telemetryEnabled: false,
    });
  } catch (err) {
    const statusCode = err && err.response && err.response.status ? err.response.status : (err && err.statusCode) || null;
    if (statusCode === 404) {
      const origPath = config.path || '';
      const altPath = origPath.includes('/sql/2.0')
        ? origPath.replace('/sql/2.0', '/sql/protocolv1')
        : (origPath.includes('/sql/protocolv1') ? origPath.replace('/sql/protocolv1', '/sql/2.0') : null);
      if (altPath) {
        console.info({ message: 'Initial connect returned 404; retrying with alternate path', altPath, connection });
        await client.connect({
          host: config.host,
          path: altPath,
          token: config.token,
          telemetryEnabled: false,
        });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  return client;
}

function buildTableName(schema, name) {
  return `${schema}.${name}`;
}

function getTableCandidates() {
  // The USCA workspace exposes *_prod tables in datalake_prod and *_int
  // tables in datalake_int, so the usca connection must probe both schemas.
  return [
    { schema: PROD_SCHEMA, connection: 'prod' },
    { schema: PROD_SCHEMA, connection: 'usca' },
    { schema: INT_SCHEMA, connection: 'usca' },
    { schema: INT_SCHEMA, connection: 'int' },
    { schema: DEV_SCHEMA, connection: 'int' },
  ];
}

async function executeAgainstFirstAvailable(tableConfigOrName, queryBuilder) {
  const tableName = typeof tableConfigOrName === 'string' ? tableConfigOrName : tableConfigOrName.name;
  const connectionHint = typeof tableConfigOrName === 'string' ? undefined : tableConfigOrName.connectionHint;
  const candidates = connectionHint
    ? getTableCandidates().filter((candidate) => candidate.connection === connectionHint)
    : getTableCandidates();

  let lastError = null;
  for (const candidate of candidates) {
    const client = await openDatabricksSession(candidate.connection);
    const session = await client.openSession();
    try {
      const fullName = buildTableName(candidate.schema, tableName);
      const sql = queryBuilder(fullName);
      const op = await session.executeStatement(sql);
      const rows = await op.fetchAll();
      await op.close();
      return { rows, schema: candidate.schema, connection: candidate.connection };
    } catch (error) {
      lastError = error;
    } finally {
      await session.close();
      await client.close();
    }
  }
  throw lastError || new Error(`Table not found in any configured schema: ${tableName}`);
}

// Some Databricks timestamp columns come back with a comma or a colon
// instead of a dot before the milliseconds (e.g. "13:38:00,000Z" or
// "13:38:00:000Z" instead of "13:38:00.000Z"). Both are invalid per RFC
// 3339/ISO 8601 — `Date` can't parse them, and a raw comma also forces CSV
// quoting downstream. Repair it wherever it appears.
function normalizeTimestampString(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(T\d{2}:\d{2}:\d{2})[,:](\d{3})(Z|[+-]\d{2}:?\d{2})?$/, '$1.$2$3');
}

function transformRow(row) {
  const result = Array.isArray(row) ? Object.assign({}, row) : { ...row };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string') result[key] = normalizeTimestampString(result[key]);
  }
  try {
    if (result.wave && typeof result.wave === 'string') result.wave = result.wave.replace(/wave /gi, '');
  } catch (e) {}
  try {
    if (result.brand && typeof result.brand === 'string') result.brand = result.brand.toUpperCase();
  } catch (e) {}
  try {
    if (result.campaign && typeof result.campaign === 'string') result.campaign = result.campaign.trim();
  } catch (e) {}
  if (result.downtime_minutes !== undefined) result.Installation_Duration = result.downtime_minutes;
  if (result.country_iso === '-1') result.country_iso = 'Unknown';
  
    // Normalize column names to lowercase canonical fields
    // updated_technology: prefer existing lowercase, then TitleCase, then infer
    const techCandidate = result.updated_technology || result.Update_Technology || result.update_technology;
    if (techCandidate) result.updated_technology = techCandidate;
    // platform: prefer existing lowercase, then TitleCase
    const platformCandidate = result.platform || result.Platform;
    if (platformCandidate) result.platform = platformCandidate;

    // remove non-canonical variants to keep responses normalized
    if (result.Update_Technology !== undefined) delete result.Update_Technology;
    if (result.Platform !== undefined) delete result.Platform;

    return result;
}

function makeRowId(row) {
  // Row grain is campaign × country × date; all three must be in the key or
  // rows of the same campaign collapse into one entry in delta maps.
  const campaign = (row.campaign || row.Campaign || row.campaign_id || row.id || row.name || "").toString();
  const country = (row.country_iso || row.iso || row.country || "").toString();
  const date = (row.date || row.Date || "").toString();
  if (campaign) return `campaign:${campaign}|${country}|${date}`;
  const recall = (row.recall || row.Recall || row.recall_id || row.Recall_ID || "").toString();
  const tech = (row.updated_technology || row.Update_Technology || row.update_technology || "").toString();
  const platform = (row.platform || row.Platform || "").toString();
  return `fallback:${country}||${recall}||${tech}||${platform}||${date}`;
}

async function queryTablesCombined(tableConfigs, limit = 100) {
  // Parallelize table probes to reduce total latency when querying multiple
  // source tables. Each table is fetched with per-table limit = `limit` and
  // results are merged. A limit of 0/falsy means unlimited (no LIMIT clause)
  // — omitting the guard here would literally send `LIMIT 0` to Databricks.
  const perTableLimit = limit && limit > 0 ? limit : undefined;
  const tasks = tableConfigs.map(async (t) => {
    try {
      const result = await executeAgainstFirstAvailable(
        t.name,
        (fullName) => (perTableLimit ? `SELECT * FROM ${fullName} LIMIT ${perTableLimit}` : `SELECT * FROM ${fullName}`)
      );
      const rows = [];
      for (const r of result.rows) {
        const row = transformRow(r);
        if (t.metadata) {
          for (const [key, value] of Object.entries(t.metadata)) {
            if (row[key] === undefined) row[key] = value;
          }
        }
        if (row.Update_Technology !== undefined && row.updated_technology === undefined) row.updated_technology = row.Update_Technology;
        if (row.Platform !== undefined && row.platform === undefined) row.platform = row.Platform;
        if (row.Update_Technology !== undefined) delete row.Update_Technology;
        if (row.Platform !== undefined) delete row.Platform;
        const tech = row.updated_technology || row.Update_Technology || row.update_technology;
        if (!t.skipMetadata) {
          let inferredTech = tech;
          if (!inferredTech) {
            const lname = (t.name || '').toLowerCase();
            if (lname.includes('oru4')) inferredTech = 'ORU4';
            else if (lname.includes('oru23')) inferredTech = 'ORU23';
          }
          if (inferredTech && row.updated_technology === undefined) row.updated_technology = inferredTech;
          let platform = row.platform || row.Platform;
          if (!platform && inferredTech) {
            if (inferredTech === 'ORU4') platform = 'MEB';
            else if (inferredTech === 'ORU23') platform = 'MQB/MLB';
          }
          if (platform && row.platform === undefined) row.platform = platform;
        }
        rows.push(row);
      }
      return rows;
    } catch (probeErr) {
      console.info({ message: 'Table not found or inaccessible, skipping', table: t.name, error: probeErr && probeErr.message ? probeErr.message : String(probeErr) });
      return [];
    }
  });

  const results = await Promise.all(tasks);
  const combinedRows = results.flat();
  return limit && limit > 0 ? combinedRows.slice(0, limit) : combinedRows;
}

async function queryFactMainCombined(limit = 100, skipEnrich = false) {
  const rows = await queryFactMainEUwithUSCACombined(limit);
  if (skipEnrich) return rows;
  try {
    const [campaignRows, countryRows] = await Promise.all([
      queryDimCampaignEUwithUSCANARCombined(1000),
      queryDimCountryEUwithUSCANARCombined(1000),
    ]);
    return enrichFactRows(rows, campaignRows, countryRows);
  } catch (error) {
    console.info({ message: 'Could not enrich fact rows with dimensions', error: error && error.message ? error.message : String(error) });
    return rows;
  }
}

async function queryFactMainEUwithUSCACombined(limit = 100) {
  const tables = [
    // EU: ORU4 + ORU23 (+ ORUnext)
    { name: 'fact_main_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' }, connectionHint: 'prod' },
    { name: 'fact_main_oru23_prod', metadata: { Source: 'EU', Update_Technology: 'ORU23', Platform: 'MQB/MLB' } },
    { name: 'fact_main_orunext', metadata: { Source: 'EU', Update_Technology: 'ORUnext' } },
    // NAR/CN: ORU4 + ORU23
    { name: 'fact_main_oru4_nar', metadata: { Source: 'NAR/CN', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_main_oru234chn_oru23nar', metadata: { Source: 'NAR/CN' } },
    // US/CA: ORU4
    { name: 'fact_main_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4', Platform: 'MEB' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryAiSummariesLatest(limit) {
  try {
    const result = await executeAgainstFirstAvailable(
      'fact_ai_summaries_facts_v3_int',
      (fullName) => `SELECT * FROM ${fullName}`
    );
    const allRows = (result.rows || []).map(transformRow);
    if (allRows.length === 0) {
      const fallbackRows = loadLocalRows('fact_ai_summaries_latest') || [];
      return limit ? fallbackRows.slice(0, limit) : fallbackRows;
    }

    // See scripts/export-combined-csv.js queryAiSummariesLatest for why this
    // filters in JS instead of `WHERE generated_at = (SELECT MAX(...))`: NULL
    // generated_at values make that SQL equality match nothing, and per-row
    // (rather than per-batch) timestamps can make MAX() match only one row.
    const validDates = allRows
      .map((row) => row.generated_at)
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    if (validDates.length === 0) {
      console.warn('fact_ai_summaries_facts_v3_int: generated_at is empty on every row; returning all rows unfiltered.');
      return limit ? allRows.slice(0, limit) : allRows;
    }
    const maxDate = validDates.reduce((max, v) => (String(v) > String(max) ? v : max));
    const latestRows = allRows.filter((row) => row.generated_at === maxDate);
    return limit ? latestRows.slice(0, limit) : latestRows;
  } catch (error) {
    console.warn('fact_ai_summaries_facts_v3_int: live query failed, falling back to local CSV', error && error.message ? error.message : String(error));
    const fallbackRows = loadLocalRows('fact_ai_summaries_latest') || [];
    return limit ? fallbackRows.slice(0, limit) : fallbackRows;
  }
}

async function countTables(tableNames) {
  const counts = [];
  for (const name of tableNames) {
    try {
      const result = await executeAgainstFirstAvailable(name, (fullName) => `SELECT COUNT(*) AS row_count FROM ${fullName}`);
      const row = Array.isArray(result.rows[0]) ? result.rows[0][0] : result.rows[0];
      counts.push({ table: name, row_count: row && (row.row_count ?? row.COUNT ?? row['count(*)'] ?? row['COUNT(*)']) });
    } catch (error) {
      counts.push({ table: name, error: error.message || String(error) });
    }
  }
  return counts;
}

app.get("/api/fact_main_oru4_prod", async (req, res) => {
  try {
    // Prefer serving from cache for fast responses; fall back to a live
    // query if cache is empty. By default return the full table; pass
    // ?limit=200 to cap explicitly.
    const limit = Number(req.query.limit) || 0;
    if (cache.fact_main && cache.fact_main.rows && cache.fact_main.rows.length) {
      return res.json(limit > 0 ? cache.fact_main.rows.slice(0, limit) : cache.fact_main.rows);
    }
    const rows = await queryFactMainCombined(limit, true);
    return res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// Also expose a combined endpoint name
app.get("/api/fact_main_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0;
    const rows = await queryFactMainCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_main_eu_usca_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0;
    const rows = await queryFactMainEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// Server-Sent Events endpoint for live fact_main updates
app.get('/events/fact_main', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');

  // send initial snapshot (full flag tells clients to replace, not merge)
  if (cache.fact_main && cache.fact_main.rows) {
    const payload = JSON.stringify({ full: true, rows: cache.fact_main.rows, updatedAt: cache.fact_main.updatedAt });
    res.write(`data: ${payload}\n\n`);
  }

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

async function queryFactTargetedVehiclesCombined(limit = 100) {
  return queryFactTargetedVehiclesEUwithUSCACombined(limit);
}

async function queryFactAdoptionRateCombined(limit = 100) {
  return queryFactAdoptionRateEUwithUSCACombined(limit);
}

async function queryFactAdoptionRateEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_adoption_rate_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_adoption_rate_oru23', metadata: { Source: 'EU' } },
    { name: 'fact_adoption_rate_oru4_nar', metadata: { Source: 'NAR/CN', Update_Technology: 'ORU4' } },
    { name: 'fact_adoption_rate_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryFactEcuCombined(limit = 100) {
  const tables = [
    { name: 'fact_ecu_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_ecu_oru23', metadata: { Source: 'EU' } },
  ];
  return queryTablesCombined(tables, limit);
}

// EU-specific ECU combined query: prefer prod-suffixed EU sources
async function queryFactEcuEUCombined(limit = 100) {
  const tables = [
    { name: 'fact_ecu_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_ecu_oru23_prod', metadata: { Source: 'EU' } },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryFactReleaseCombined(limit = 100) {
  return queryFactReleaseEUwithUSCACombined(limit);
}

async function queryDimCampaignCombined(limit = 100) {
  return queryDimCampaignEUwithUSCANARCombined(limit);
}

async function queryDimCountryCombined(limit = 100) {
  return queryDimCountryEUwithUSCANARCombined(limit);
}

// Local CSV exports sometimes wrap string cells in stray quotes (the same
// artifact normalizeAggDate works around for timestamps — e.g. a
// country_iso cell literally containing `"DE"` including the quote chars).
// A join key that isn't normalized this way silently fails to match its
// lookup Map on one side only, so the affected field resolves to "" for
// every row instead of throwing — region/country_name broke exactly this
// way while brand/platform/recall (joined via `campaign`, unaffected by
// the quoting) kept working, which is why "every filter except Region"
// was the symptom rather than an outright error.
function normalizeJoinKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/^"+|"+$/g, "");
}

function normalizeFactCampaignKey(row) {
  return normalizeJoinKey(row.campaign ?? row.Campaign ?? row.campaign_id ?? row.id ?? row.name ?? "");
}

function buildFactCampaignLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const campaign = normalizeFactCampaignKey(row);
    if (!campaign) continue;
    lookup.set(campaign, {
      brand: row.brand || row.Brand || undefined,
      platform: row.platform || row.Platform || undefined,
      // recall_id is the campaign column itself unless an explicit
      // recall/recall_id column exists — each campaign IS a recall.
      recall: row.recall || row.Recall || row.recall_id || row.Recall_ID || campaign,
    });
  }
  return lookup;
}

function buildFactCountryLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const iso = normalizeJoinKey(row.country_iso ?? row.iso ?? row.id);
    if (!iso) continue;
    lookup.set(iso, {
      country_name: row.country_name ?? row.country ?? undefined,
      region_name: row.region_name ?? row.region ?? undefined,
      // region_name (display, e.g. "Europe") must win over region/Source
      // (technical merge-lineage tag, e.g. "EU"/"USCA"/"NAR-CN") — those are
      // deliberately different values in this data model, and the filter
      // catalog's regionCountryMap already prioritizes region_name this way.
      region: row.region_name ?? row.region ?? undefined,
    });
  }
  return lookup;
}

function enrichFactRows(rows, campaignRows, countryRows) {
  const campaignLookup = buildFactCampaignLookup(campaignRows);
  const countryLookup = buildFactCountryLookup(countryRows);
  return rows.map((row) => {
    const campaignKey = normalizeFactCampaignKey(row);
    const dimCampaign = campaignLookup.get(campaignKey);
    const countryIso = normalizeJoinKey(row.country_iso ?? row.country ?? row.iso);
    const dimCountry = countryIso ? countryLookup.get(countryIso) : undefined;

    const enriched = { ...row };
    if (dimCampaign) {
      if (!enriched.brand && dimCampaign.brand) enriched.brand = dimCampaign.brand;
      if (!enriched.platform && dimCampaign.platform) enriched.platform = dimCampaign.platform;
      if (!enriched.recall && dimCampaign.recall) enriched.recall = dimCampaign.recall;
    }
    if (dimCountry) {
      if (!enriched.country_name && dimCountry.country_name) enriched.country_name = dimCountry.country_name;
      if (!enriched.region_name && dimCountry.region_name) enriched.region_name = dimCountry.region_name;
      // Always prefer dim_country's resolved region (display name) over
      // whatever the fact row itself might already carry as `region` — that
      // field is often the technical Source/merge-lineage tag, not the
      // display region, and would otherwise silently win here.
      if (dimCountry.region) enriched.region = dimCountry.region;
    }
    return enriched;
  });
}

// Collapse the ~1M-row fact_main table into a compact cube keyed by
// date × region × country × brand × platform × recall, carrying the
// pre-summed components every KPI is built from. Every dashboard KPI is a
// sum or a ratio-of-sums, so the browser can reconstruct exact whole-dataset
// values, per-day series and windowed deltas from this cube without ever
// receiving the raw rows — turning a ~482 MB transfer into a few MB. Runs in
// a single pass (enrich inline) so we never materialize 1M enriched objects.
function toNum(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function normalizeAggDate(raw) {
  if (!raw) return '';
  // Local CSV timestamps arrive double-quoted (value is literally
  // `"2021-03-04T00:00:00.000Z"` including the quote chars), so strip
  // surrounding quotes/whitespace before parsing or Date fails and we'd bucket
  // by a garbage substring.
  const s = normalizeTimestampString(String(raw).trim().replace(/^"+|"+$/g, ''));
  const d = new Date(s);
  if (Number.isNaN(d.valueOf())) return s.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function buildFactMainAggregate(factRows, campaignRows, countryRows) {
  const campaignLookup = buildFactCampaignLookup(campaignRows);
  const countryLookup = buildFactCountryLookup(countryRows);
  const groups = new Map();

  for (const row of factRows) {
    const campaignKey = normalizeFactCampaignKey(row);
    const dimCampaign = campaignLookup.get(campaignKey) || {};
    const countryIso = normalizeJoinKey(row.country_iso ?? row.country ?? row.iso);
    const dimCountry = (countryIso ? countryLookup.get(countryIso) : undefined) || {};

    const brand = row.brand || dimCampaign.brand || '';
    const platform = row.platform || dimCampaign.platform || '';
    const recall = row.recall || dimCampaign.recall || campaignKey || '';
    const country_name = row.country_name || dimCountry.country_name || row.country || '';
    // dimCountry.region (region_name-prioritized, see buildFactCountryLookup)
    // must win over the fact row's own `region` — that's typically the
    // technical Source/merge-lineage tag (e.g. "EU"), not the display region
    // ("Europe") the filter checkboxes use, and letting it win here is what
    // silently broke Region-level filtering while Country-level kept working.
    const region = dimCountry.region || row.region_name || row.region || '';
    const date = normalizeAggDate(row.date ?? row.Date);

    const key = `${date} ${region} ${country_name} ${brand} ${platform} ${recall}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        date, region, country_name, brand, platform, recall,
        _agg: 1, _n: 0,
        successful_updates: 0,
        _quality_sum: 0,
        downtime_minutes: 0,
        customerWarning_minor: 0,
        customerWarning_major: 0,
        update_operations: 0,
        lb_common_vehicles: 0,
        lb_backend_vehicles: 0,
        lb_aftersales_vehicles: 0,
        cost_savings: 0,
        co2_savings: 0,
      };
      groups.set(key, g);
    }
    const updates = toNum(row.successful_updates);
    const quality = toNum(row.quality);
    g._n += 1;
    g.successful_updates += updates;
    g._quality_sum += quality;
    g.downtime_minutes += toNum(row.downtime_minutes);
    g.customerWarning_minor += toNum(row.customerWarning_minor);
    g.customerWarning_major += toNum(row.customerWarning_major);
    g.update_operations += toNum(row.update_operations);
    g.lb_common_vehicles += toNum(row.lb_common_vehicles);
    g.lb_backend_vehicles += toNum(row.lb_backend_vehicles);
    g.lb_aftersales_vehicles += toNum(row.lb_aftersales_vehicles);
    g.cost_savings += toNum(row.cost_savings);
    g.co2_savings += toNum(row.co2_savings);
  }

  return Array.from(groups.values());
}

// Adoption Rate KPI = SUM(successful_updates) from fact_adoption_rate WHERE
// (successful_update_date - targeted_date) <= 60 days. Aggregated the same
// way as fact_main (small cube, not raw rows) so it can ship in the eager
// /api/dashboard_snapshot response — fact_adoption_rate's row-level data is
// still only fetched lazily via /api/dlcm_snapshot for the DLCM adoption
// curve, which needs per-campaign granularity this cube doesn't carry.
function buildAdoptionRateAggregate(adoptionRows, campaignRows, countryRows) {
  const campaignLookup = buildFactCampaignLookup(campaignRows);
  const countryLookup = buildFactCountryLookup(countryRows);
  const groups = new Map();

  for (const row of adoptionRows) {
    const targetedRaw = row.targeted_date ?? row.TargetedDate;
    const successfulRaw = row.successful_update_date ?? row.SuccessfulUpdateDate;
    if (!successfulRaw) continue;

    // Real exports already carry a `range` column — prefer it over
    // recomputing from the two dates (avoids any date-parsing mismatch).
    // Only fall back to the date difference if `range` is genuinely absent
    // (parseRangeRaw returns null, not 0 — a missing value must not be
    // silently treated as "0 days", which would wrongly count as eligible).
    const rangeRaw = row.range ?? row.Range;
    let rangeDays = rangeRaw === undefined || rangeRaw === null || rangeRaw === '' ? null : Number(rangeRaw);
    if (rangeDays === null || Number.isNaN(rangeDays)) {
      if (!targetedRaw) continue;
      const targeted = new Date(normalizeTimestampString(String(targetedRaw).trim().replace(/^"+|"+$/g, '')));
      const successful = new Date(normalizeTimestampString(String(successfulRaw).trim().replace(/^"+|"+$/g, '')));
      if (Number.isNaN(targeted.valueOf()) || Number.isNaN(successful.valueOf())) continue;
      rangeDays = (successful.valueOf() - targeted.valueOf()) / (24 * 60 * 60 * 1000);
    }
    if (rangeDays > 60) continue;

    const campaignKey = normalizeFactCampaignKey(row);
    const dimCampaign = campaignLookup.get(campaignKey) || {};
    const countryIso = normalizeJoinKey(row.country_iso ?? row.country ?? row.iso);
    const dimCountry = (countryIso ? countryLookup.get(countryIso) : undefined) || {};

    const brand = row.brand || dimCampaign.brand || '';
    const platform = row.platform || dimCampaign.platform || '';
    const recall = row.recall || dimCampaign.recall || campaignKey || '';
    const country_name = row.country_name || dimCountry.country_name || row.country || '';
    const region = dimCountry.region || row.region_name || row.region || '';
    const date = normalizeAggDate(successfulRaw);

    const key = `${date} ${region} ${country_name} ${brand} ${platform} ${recall}`;
    let g = groups.get(key);
    if (!g) {
      g = { date, region, country_name, brand, platform, recall, _agg: 1, successful_updates: 0 };
      groups.set(key, g);
    }
    g.successful_updates += toNum(row.successful_updates);
  }

  return Array.from(groups.values());
}

function buildDashboardFilterCatalog(factRows, campaignRows, countryRows) {
  const enriched = enrichFactRows(factRows, campaignRows, countryRows);
  const brandOptions = [...new Set(enriched.map((row) => row.brand).filter(Boolean))].sort();
  const platformOptions = [...new Set(enriched.map((row) => row.platform).filter(Boolean))].sort();
  const recallOptions = [...new Set(enriched.map((row) => row.recall).filter(Boolean))].sort();
  const regionOptions = [...new Set(enriched.map((row) => row.region || row.region_name).filter(Boolean))].sort();
  const countryOptions = [...new Set(enriched.map((row) => row.country_name || row.country).filter(Boolean))].sort();

  const regionCountryMap = new Map();
  for (const row of countryRows || []) {
    const region = row.region_name ?? row.region ?? '';
    const country = row.country_name ?? row.country ?? row.country_iso ?? '';
    if (!region || !country) continue;
    if (!regionCountryMap.has(region)) regionCountryMap.set(region, []);
    regionCountryMap.get(region).push(country);
  }
  for (const countries of regionCountryMap.values()) countries.sort();

  return {
    brands: brandOptions,
    platforms: platformOptions,
    recalls: recallOptions,
    regions: regionOptions,
    countries: countryOptions,
    regionCountryMap: Object.fromEntries([...regionCountryMap.entries()]),
  };
}

app.get("/api/fact_targeted_vehicles_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactTargetedVehiclesCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_adoption_rate_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactAdoptionRateCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_adoption_rate_eu_usca_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactAdoptionRateEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_ecu_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactEcuCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU-only ECU combined endpoint
app.get("/api/fact_ecu_eu_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactEcuEUCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA combined for fact_frequency
async function queryFactFrequencyEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_frequency_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_frequency_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_frequency_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/fact_frequency_eu_usca_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactFrequencyEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA combined for fact_release
async function queryFactReleaseEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_release_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_release_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_release_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/fact_release_eu_usca_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactReleaseEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA combined for fact_targeted_vehicles
async function queryFactTargetedVehiclesEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_targeted_vehicles_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_targeted_vehicles_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_targeted_vehicles_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/fact_targeted_vehicles_eu_usca_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactTargetedVehiclesEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_release_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryFactReleaseCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/dim_campaign_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryDimCampaignCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA + NAR/CN combined for dim_campaign
async function queryDimCampaignEUwithUSCANARCombined(limit = 100) {
  const tables = [
    { name: 'dim_campaign_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'dim_campaign_oru23_prod', metadata: { Source: 'EU', Update_Technology: 'ORU23' } },
    { name: 'dim_campaign_orunext', metadata: { Source: 'EU' } },
    { name: 'dim_campaign_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
    { name: 'dim_campaign_oru234chn_oru23nar', metadata: { Source: 'NAR/CN' } },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/dim_campaign_eu_usca_narch_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryDimCampaignEUwithUSCANARCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/dim_country_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryDimCountryCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA + NAR/CN combined for dim_country
async function queryDimCountryEUwithUSCANARCombined(limit = 100) {
  const tables = [
    { name: 'dim_country_oru4_prod', skipMetadata: true },
    { name: 'dim_country_oru23_prod', metadata: { Source: 'EU' }, skipMetadata: true },
    { name: 'dim_country_oru4_int', metadata: { Source: 'USCA' }, connectionHint: 'usca', skipMetadata: true },
    { name: 'dim_country_oru234chn_oru23nar', metadata: { Source: 'NAR/CN' }, skipMetadata: true },
  ];
  const rows = await queryTablesCombined(tables, 0);
  const filtered = rows.filter((row) => {
    const name = row.country_name ?? row.country ?? '';
    return name !== undefined && name !== null && String(name).trim() !== '';
  });
  const deduped = [];
  const seen = new Set();
  for (const row of filtered) {
    const key = String(row.country_iso ?? row.iso ?? row.id ?? '').trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    delete row.updated_technology;
    delete row.platform;
    deduped.push(row);
  }
  return limit && limit > 0 ? deduped.slice(0, limit) : deduped;
}

app.get("/api/dim_country_eu_usca_narch_combined", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryDimCountryEUwithUSCANARCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_ai_summaries_latest", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 0; // 0 = unlimited
    const rows = await queryAiSummariesLatest(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/table_counts", async (req, res) => {
  try {
    const groups = {
      fact_main: [
        'fact_main_oru4_prod',
        'fact_main_oru23',
        'fact_main_oru4_nar',
        'fact_main_orunext',
        'fact_main_oru4_int',
      ],
      fact_frequency: [
        'fact_frequency_oru4_prod',
        'fact_frequency_oru23_prod',
        'fact_frequency_oru4_int',
      ],
      fact_targeted_vehicles: [
        'fact_targeted_vehicles_oru4_prod',
        'fact_targeted_vehicles_oru23',
        'fact_targeted_vehicles_oru4_nar',
      ],
      fact_adoption_rate: [
        'fact_adoption_rate_oru4_prod',
        'fact_adoption_rate_oru23',
        'fact_adoption_rate_oru4_nar',
      ],
      fact_ecu: [
        'fact_ecu_oru4_prod',
        'fact_ecu_oru23',
      ],
      fact_release: [
        'fact_release_oru4_prod',
        'fact_release_oru23',
        'fact_release_oru4_nar',
      ],
      dim_campaign: [
        'dim_campaign_oru4_prod',
        'dim_campaign_oru23',
        'dim_campaign_oru4_nar',
        'dim_campaign_orunext',
      ],
      dim_country: [
        'dim_country_oru4_prod',
        'dim_country_oru23_dev',
        'dim_country_oru234chn_oru23nar',
        'dim_country_oru4_nar',
      ],
      fact_ai_summaries: ['fact_ai_summaries_facts_v3_int'],
    };

    const results = {};
    for (const [group, tables] of Object.entries(groups)) {
      results[group] = await countTables(tables);
    }
    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// Create HTTP server and WebSocket server for low-latency updates
const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Send initial snapshot if available
  try {
    if (cache.fact_main && cache.fact_main.rows && cache.fact_main.rows.length) {
      ws.send(JSON.stringify({ full: true, rows: cache.fact_main.rows, updatedAt: cache.fact_main.updatedAt }));
    }
  } catch (e) {}

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data && data.action === 'ping') ws.send(JSON.stringify({ action: 'pong' }));
      // Could add subscribe/unsubscribe handling here
    } catch (e) {}
  });
});

server.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
