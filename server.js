import express from "express";
import cors from "cors";
import { DBSQLClient } from "@databricks/sql";
import dotenv from "dotenv";
import http from "http";
import { createRequire } from "module";

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

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// In-memory cache and SSE clients for live updates
// Default refresh every 15s for more responsive dashboards (can override with env)
const CACHE_REFRESH_INTERVAL_MS = Number(process.env.CACHE_REFRESH_INTERVAL_MS) || 15000;
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
  try {
    const rows = await queryFactMainCombined(1000);
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
  return [
    { schema: PROD_SCHEMA, connection: 'prod' },
    { schema: PROD_SCHEMA, connection: 'usca' },
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

function transformRow(row) {
  const result = Array.isArray(row) ? Object.assign({}, row) : { ...row };
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
  // Prefer `campaign` as the stable identifier. Fall back to a composite
  // key if `campaign` is not present.
  const campaign = (row.campaign || row.Campaign || row.campaign_id || row.id || row.name || "").toString();
  if (campaign) return `campaign:${campaign}`;
  const country = (row.country_iso || row.iso || row.country || "").toString();
  const recall = (row.recall || row.Recall || row.recall_id || row.Recall_ID || "").toString();
  const tech = (row.updated_technology || row.Update_Technology || row.update_technology || "").toString();
  const platform = (row.platform || row.Platform || "").toString();
  return `fallback:${country}||${recall}||${tech}||${platform}`;
}

async function queryTablesCombined(tableConfigs, limit = 100) {
  // Parallelize table probes to reduce total latency when querying multiple
  // source tables. Each table is fetched with per-table limit = `limit` and
  // results are merged.
  const perTableLimit = limit;
  const tasks = tableConfigs.map(async (t) => {
    try {
      const result = await executeAgainstFirstAvailable(t.name, (fullName) => `SELECT * FROM ${fullName} LIMIT ${perTableLimit}`);
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
  return combinedRows.slice(0, limit);
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
    { name: 'fact_main_oru23', metadata: { Source: 'EU' } },
    { name: 'fact_main_oru234chn_oru23nar', metadata: { Source: 'EU' } },
    { name: 'fact_main_oru4_nar', metadata: { Source: 'EU' } },
    { name: 'fact_main_orunext', metadata: { Source: 'EU' } },
    { name: 'fact_main_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'USCA' }, connectionHint: 'usca' },
    { name: 'fact_main_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryAiSummariesLatest(limit) {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const result = await executeAgainstFirstAvailable(
    'fact_ai_summaries_facts_v3_int',
    (fullName) => `SELECT * FROM ${fullName} WHERE generated_at = (SELECT MAX(generated_at) FROM ${fullName}) ${limitClause}`
  );
  return result.rows.map(transformRow);
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
    // query if cache is empty.
    const limit = Math.min(1000, Number(req.query.limit) || 1000);
    if (cache.fact_main && cache.fact_main.rows && cache.fact_main.rows.length) {
      return res.json(cache.fact_main.rows.slice(0, limit));
    }
    // Return a small sample quickly while cache warms up.
    const sampleLimit = Math.min(200, limit);
    const rows = await queryFactMainCombined(sampleLimit, true);
    return res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// Also expose a combined endpoint name
app.get("/api/fact_main_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactMainCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_main_eu_usca_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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

  // send initial snapshot
  if (cache.fact_main && cache.fact_main.rows) {
    const payload = JSON.stringify({ rows: cache.fact_main.rows, updatedAt: cache.fact_main.updatedAt });
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
    { name: 'fact_adoption_rate_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_adoption_rate_oru23', metadata: { Source: 'EU' } },
    { name: 'fact_adoption_rate_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryFactEcuCombined(limit = 100) {
  const tables = [
    { name: 'fact_ecu_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_ecu_oru23' },
  ];
  return queryTablesCombined(tables, limit);
}

// EU-specific ECU combined query: prefer prod-suffixed EU sources
async function queryFactEcuEUCombined(limit = 100) {
  const tables = [
    { name: 'fact_ecu_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
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

function normalizeFactCampaignKey(row) {
  return row.campaign ?? row.Campaign ?? row.campaign_id ?? row.id ?? row.name ?? "";
}

function buildFactCampaignLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const campaign = normalizeFactCampaignKey(row);
    if (!campaign) continue;
    lookup.set(campaign, {
      brand: row.brand || row.Brand || undefined,
      platform: row.platform || row.Platform || undefined,
      recall: row.recall || row.Recall || row.recall_id || row.Recall_ID || undefined,
    });
  }
  return lookup;
}

function buildFactCountryLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const iso = row.country_iso ?? row.iso ?? row.id;
    if (!iso) continue;
    lookup.set(iso, {
      country_name: row.country_name ?? row.country ?? undefined,
      region_name: row.region_name ?? row.region ?? undefined,
      region: row.region ?? row.region_name ?? undefined,
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
    const countryIso = row.country_iso ?? row.country ?? row.iso;
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
      if (!enriched.region && dimCountry.region) enriched.region = dimCountry.region;
    }
    return enriched;
  });
}

app.get("/api/fact_targeted_vehicles_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactTargetedVehiclesCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_adoption_rate_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactAdoptionRateCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_adoption_rate_eu_usca_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactAdoptionRateEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_ecu_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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
    { name: 'fact_frequency_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_frequency_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_frequency_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/fact_frequency_eu_usca_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactTargetedVehiclesEUwithUSCACombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_release_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryFactReleaseCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/dim_campaign_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryDimCampaignCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA + NAR/CH combined for dim_campaign
async function queryDimCampaignEUwithUSCANARCombined(limit = 100) {
  const tables = [
    { name: 'dim_campaign_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'dim_campaign_oru23_prod', metadata: { Source: 'EU', Update_Technology: 'ORU23' } },
    { name: 'dim_campaign_orunext', metadata: { Source: 'EU' } },
    { name: 'dim_campaign_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
    { name: 'dim_campaign_oru234chn_oru23nar', metadata: { Source: 'NAR/CH' } },
  ];
  return queryTablesCombined(tables, limit);
}

app.get("/api/dim_campaign_eu_usca_narch_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryDimCampaignEUwithUSCANARCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/dim_country_combined", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryDimCountryCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

// EU + US/CA + NAR/CH combined for dim_country
async function queryDimCountryEUwithUSCANARCombined(limit = 100) {
  const tables = [
    { name: 'dim_country_oru4_prod', skipMetadata: true },
    { name: 'dim_country_oru23_prod', metadata: { Source: 'EU' }, skipMetadata: true },
    { name: 'dim_country_oru4_int', metadata: { Source: 'USCA' }, connectionHint: 'usca', skipMetadata: true },
    { name: 'dim_country_oru234chn_oru23nar', metadata: { Source: 'NAR/CH' }, skipMetadata: true },
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
    const limit = Math.min(1000, Number(req.query.limit) || 100);
    const rows = await queryDimCountryEUwithUSCANARCombined(limit);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || String(error), stack: error.stack });
  }
});

app.get("/api/fact_ai_summaries_latest", async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit) || 100);
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
