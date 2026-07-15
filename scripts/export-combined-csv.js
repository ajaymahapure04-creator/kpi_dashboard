import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';
import { generateLocalJsonFilesFromCsvs } from './local-data-utils.mjs';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');

// Determine export max rows from CLI or environment.
// - CLI: `--max=5000` or `--all`
// - ENV: `EXPORT_MAX_ROWS=5000` or `EXPORT_MAX_ROWS=all`
// A value of 0 or "all" means no LIMIT (export everything). Exports
// everything by default when no flag/env var is given at all — pass
// `--max=1000` explicitly if you want a capped sample instead.
const argv = process.argv.slice(2);
// allow exporting a single file: --only=filename.csv
const ONLY_ARG = argv.find((a) => a.startsWith('--only='));
const ONLY_NAME = ONLY_ARG ? ONLY_ARG.split('=')[1] : undefined;

function parseMaxRows() {
  const argMax = argv.find((a) => a.startsWith('--max='));
  if (argv.includes('--all')) return 0;
  if (argMax) {
    const v = argMax.split('=')[1];
    if (!v) return 1000;
    if (v.toLowerCase && v.toLowerCase() === 'all') return 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  }
  const envVal = process.env.EXPORT_MAX_ROWS || process.env.MAX_EXPORT_ROWS;
  if (envVal) {
    if (String(envVal).toLowerCase() === 'all') return 0;
    const n = Number(envVal);
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  }
  return 0; // no flag/env given -> export everything, same as --all
}

const MAX_ROWS = parseMaxRows();

// helper: check if we should export only a specific file
function shouldExport(name) {
  if (!ONLY_NAME) return true;
  return name === ONLY_NAME || name === `data/${ONLY_NAME}` || name.endsWith(ONLY_NAME);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function buildTableName(schema, name) {
  return `${schema}.${name}`;
}

function getTableCandidates() {
  const PROD_SCHEMA = process.env.DATALAKE_PROD_SCHEMA || 'hive_metastore.datalake_prod';
  const INT_SCHEMA = process.env.DATALAKE_INT_SCHEMA || 'hive_metastore.datalake_int';
  const DEV_SCHEMA = process.env.DATALAKE_DEV_SCHEMA || 'hive_metastore.datalake_dev';
  // The USCA workspace exposes *_prod tables in datalake_prod and *_int
  // tables in datalake_int, so the usca connection must probe both schemas.
  // Keep this list identical to getTableCandidates() in server.js.
  return [
    { schema: PROD_SCHEMA, connection: 'prod' },
    { schema: PROD_SCHEMA, connection: 'usca' },
    { schema: INT_SCHEMA, connection: 'usca' },
    { schema: INT_SCHEMA, connection: 'int' },
    { schema: DEV_SCHEMA, connection: 'int' },
  ];
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
  const client = new DBSQLClient();
  await client.connect({
    host: config.host,
    path: config.path,
    token: config.token,
    telemetryEnabled: false,
  });
  return client;
}

async function executeAgainstFirstAvailable(tableConfigOrName, queryBuilder) {
  const tableName = typeof tableConfigOrName === 'string' ? tableConfigOrName : tableConfigOrName.name;
  const candidates = typeof tableConfigOrName === 'string'
    ? getTableCandidates()
    : getTableCandidates().filter((candidate) =>
        tableConfigOrName.connectionHint
          ? candidate.connection === tableConfigOrName.connectionHint
          : true
      );

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
      try {
        await session.close();
      } catch (e) {}
      try {
        await client.close();
      } catch (e) {}
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
  try { if (result.wave && typeof result.wave === 'string') result.wave = result.wave.replace(/wave /gi, ''); } catch (e) {}
  try { if (result.brand && typeof result.brand === 'string') result.brand = result.brand.toUpperCase(); } catch (e) {}
  try { if (result.campaign && typeof result.campaign === 'string') result.campaign = result.campaign.trim(); } catch (e) {}
  if (result.downtime_minutes !== undefined) result.Installation_Duration = result.downtime_minutes;
  if (result.country_iso === '-1') result.country_iso = 'Unknown';

  const techCandidate = result.updated_technology || result.Update_Technology || result.update_technology;
  if (techCandidate) result.updated_technology = techCandidate;
  const platformCandidate = result.platform || result.Platform;
  if (platformCandidate) result.platform = platformCandidate;

  if (result.Update_Technology !== undefined) delete result.Update_Technology;
  if (result.Platform !== undefined) delete result.Platform;
  return result;
}

async function queryTablesCombined(tableConfigs, limit = 100) {
  // If limit is 0 or falsy, treat as unlimited (no per-table LIMIT clause)
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
      return [];
    }
  });

  const results = await Promise.all(tasks);
  const combinedRows = results.flat();
  return limit && limit > 0 ? combinedRows.slice(0, limit) : combinedRows;
}

async function queryDimCampaignCombined(limit = 100) {
  return queryDimCampaignEUwithUSCANARCombined(limit);
}

async function queryDimCountryCombined(limit = 100) {
  return queryDimCountryEUwithUSCANARCombined(limit);
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

async function queryFactFrequencyEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_frequency_oru4_prod', metadata: { Source: 'EU', Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_frequency_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_frequency_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryFactTargetedVehiclesEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_targeted_vehicles_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_targeted_vehicles_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_targeted_vehicles_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
  ];
  return queryTablesCombined(tables, limit);
}

async function queryFactReleaseEUwithUSCACombined(limit = 100) {
  const tables = [
    { name: 'fact_release_oru4_prod', metadata: { Update_Technology: 'ORU4', Platform: 'MEB' } },
    { name: 'fact_release_oru23_prod', metadata: { Source: 'EU' } },
    { name: 'fact_release_oru4_int', metadata: { Source: 'USCA', Update_Technology: 'ORU4' }, connectionHint: 'usca' },
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
  const deduped = dedupeRowsByKey(filtered, 'country_iso').map((row) => {
    delete row.updated_technology;
    delete row.platform;
    return row;
  });
  return limit && limit > 0 ? deduped.slice(0, limit) : deduped;
}

async function queryAiSummariesLatest(limit = 100) {
  let result;
  try {
    result = await executeAgainstFirstAvailable(
      'fact_ai_summaries_facts_v3_int',
      (fullName) => `SELECT * FROM ${fullName}`
    );
  } catch (err) {
    console.warn('fact_ai_summaries_facts_v3_int: query failed, falling back to local CSV', err && err.message ? err.message : err);
    return readLocalCsvRows('fact_ai_summaries_latest');
  }
  const allRows = ((result && result.rows) ? result.rows : []).map(transformRow);
  if (allRows.length === 0) {
    const fallbackRows = readLocalCsvRows('fact_ai_summaries_latest');
    return fallbackRows.length ? (limit ? fallbackRows.slice(0, limit) : fallbackRows) : [];
  }

  // Filter down to the latest run in JS rather than a SQL
  // `WHERE generated_at = (SELECT MAX(...))` clause: if generated_at is
  // NULL on any/all rows, that SQL equality matches nothing (NULL = NULL is
  // never true), and if timestamps are per-row rather than per-batch, MAX()
  // can match only a single row instead of the whole latest run — both
  // silently produce an empty (blank) export.
  const validDates = allRows
    .map((row) => row.generated_at)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (validDates.length === 0) {
    console.warn('fact_ai_summaries_facts_v3_int: generated_at is empty on every row; exporting all rows unfiltered.');
    return limit ? allRows.slice(0, limit) : allRows;
  }
  const maxDate = validDates.reduce((max, v) => (String(v) > String(max) ? v : max));
  const latestRows = allRows.filter((row) => row.generated_at === maxDate);
  return limit ? latestRows.slice(0, limit) : latestRows;
}

function cleanObjectValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return ',';
  const first = lines[0];
  const commaCount = (first.match(/,/g) || []).length;
  const tabCount = (first.match(/\t/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

function parseCsvText(text) {
  const delimiter = detectDelimiter(text);
  const records = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  if (records.length < 2) return [];
  const headers = records[0].map((h) => String(h).trim());
  return records.slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        const v = r[idx];
        if (v !== undefined && v !== '') obj[h] = v;
      });
      return obj;
    });
}

function readLocalCsvRows(name) {
  const filePath = path.join(DATA_DIR, `${name}.csv`);
  if (!fs.existsSync(filePath)) return [];
  return parseCsvText(fs.readFileSync(filePath, 'utf8'));
}

function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const escape = (value) => {
    const raw = cleanObjectValue(value);
    if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    const rowValues = headers.map((header) => escape(row[header]));
    lines.push(rowValues.join(','));
  }
  return lines.join('\n');
}

function dedupeRowsByKey(rows, keyField) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = String(row[keyField] ?? row.iso ?? row.id ?? '').trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function writeCsvFile(name, rows) {
  const csv = rowsToCsv(rows);
  const filePath = path.join(DATA_DIR, name);
  const tmpPath = filePath + '.tmp';
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.writeFileSync(tmpPath, csv, 'utf8');
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (e) {
        const fallback = filePath + '.new';
        try {
          fs.renameSync(tmpPath, fallback);
          console.log(`Wrote fallback file ${fallback} (${rows.length} rows) - original file is locked`);
          return;
        } catch (e2) {
          // if fallback also fails, attempt to remove tmp and throw
          try { fs.unlinkSync(tmpPath); } catch (e3) {}
          throw e2;
        }
      }
      console.log(`Wrote ${filePath} (${rows.length} rows)`);
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitMs = 250 * attempt;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

function enrichFactRows(rows, campaignRows, countryRows) {
  const campaignLookup = new Map();
  for (const row of campaignRows) {
    const campaign = row.campaign ?? row.Campaign ?? row.campaign_id ?? row.id ?? row.name ?? '';
    if (!campaign) continue;
    // recall_id is the campaign column itself unless an explicit
    // recall/recall_id column exists — each campaign IS a recall.
    campaignLookup.set(campaign, {
      brand: row.brand || row.Brand,
      platform: row.platform || row.Platform,
      recall: row.recall || row.Recall || row.recall_id || row.Recall_ID || campaign,
    });
  }
  const countryLookup = new Map();
  for (const row of countryRows) {
    const iso = row.country_iso ?? row.iso ?? row.id;
    if (!iso) continue;
    countryLookup.set(iso, {
      country_name: row.country_name ?? row.country,
      region_name: row.region_name ?? row.region,
      region: row.region ?? row.region_name,
    });
  }
  return rows.map((row) => {
    const campaignKey = row.campaign ?? row.Campaign ?? row.campaign_id ?? row.id ?? row.name ?? '';
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

async function exportAllCsv() {
  ensureDataDir();
  // One canonical file per dataset — each query already merges the full
  // EU + US/CA + NAR/CN combination (fact_ecu is EU-only by design).
  // Keep these names in sync with LOCAL_ENDPOINT_ALIASES in server.js and
  // scripts/generate-mock-data.mjs.
  const exports = [
    { name: 'fact_main.csv', fn: () => queryFactMainCombined(MAX_ROWS) },
    { name: 'fact_adoption_rate.csv', fn: () => queryFactAdoptionRateEUwithUSCACombined(MAX_ROWS) },
    { name: 'fact_ecu.csv', fn: () => queryFactEcuCombined(MAX_ROWS) },
    { name: 'fact_targeted_vehicles.csv', fn: () => queryFactTargetedVehiclesEUwithUSCACombined(MAX_ROWS) },
    { name: 'fact_release.csv', fn: () => queryFactReleaseEUwithUSCACombined(MAX_ROWS) },
    { name: 'dim_campaign.csv', fn: () => queryDimCampaignEUwithUSCANARCombined(MAX_ROWS) },
    { name: 'dim_country.csv', fn: () => queryDimCountryEUwithUSCANARCombined(MAX_ROWS) },
    { name: 'fact_ai_summaries_latest.csv', fn: () => queryAiSummariesLatest(MAX_ROWS) },
  ];

  for (const item of exports) {
    try {
      if (!shouldExport(item.name)) continue;
      const rows = await item.fn();
      writeCsvFile(item.name, rows);
      if (ONLY_NAME) break;
    } catch (error) {
      console.error(`Failed to export ${item.name}:`, error && error.message ? error.message : error);
    }
  }

  // Local-data mode prefers JSON over CSV (faster to parse, no quoting/type
  // ambiguity) and server.js would otherwise only generate it lazily on next
  // boot. Regenerate it here too so `data/*.json` is fresh immediately after
  // export, not stale from before this run.
  try {
    const generated = generateLocalJsonFilesFromCsvs();
    console.log(`Generated JSON snapshots for: ${generated.join(', ') || '(none)'}`);
  } catch (error) {
    console.error('Failed to generate local JSON files from CSVs:', error && error.message ? error.message : error);
  }
}

exportAllCsv().catch((err) => {
  console.error('Export failed:', err && err.message ? err.message : err);
  process.exit(1);
});
