import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_NAME = 'fact_adoption_rate_combined.csv';
const OUT_PATH = path.join(DATA_DIR, OUT_NAME);

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function cleanObjectValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); headers.push(key); }
    }
  }
  const escape = (v) => {
    const raw = cleanObjectValue(v);
    if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) return '"' + raw.replace(/"/g, '""') + '"';
    return raw;
  };
  const hdr = headers.join(',') + '\n';
  const lines = rows.map(r => headers.map(h => escape(r[h])).join(','));
  return hdr + lines.join('\n') + '\n';
}

async function fetchAll(fq, config) {
  const client = new DBSQLClient();
  await client.connect(config);
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT * FROM ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    return rows.map(r => Array.isArray(r) ? Object.assign({}, r) : r);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

async function run() {
  ensureDataDir();
  const euConfig = { host: process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN };
  const uscaConfig = { host: process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_TOKEN };

  const sources = [
    { fq: 'hive_metastore.datalake_prod.fact_adoption_rate_oru4_prod', label: 'ORU4', config: euConfig },
    { fq: 'hive_metastore.datalake_prod.fact_adoption_rate_oru23_prod', label: 'ORU23', config: euConfig },
    { fq: 'hive_metastore.datalake_int.fact_adoption_rate_oru4_int', label: 'ORU4_INT', config: uscaConfig },
  ];

  const all = [];
  const counts = {};
  for (const s of sources) {
    try {
      const rows = await fetchAll(s.fq, { host: s.config.host, path: s.config.path, token: s.config.token, telemetryEnabled: false });
      counts[s.label] = rows.length;
      for (const r of rows) {
        r.Source = s.label;
        all.push(r);
      }
    } catch (err) {
      console.error(`Warning: failed to fetch ${s.fq}:`, err && err.message ? err.message : err);
      counts[s.label] = 0;
    }
  }

  const csv = rowsToCsv(all);
  const tmp = OUT_PATH + '.tmp';
  fs.writeFileSync(tmp, csv, 'utf8');
  try { fs.renameSync(tmp, OUT_PATH); }
  catch (e) { fs.writeFileSync(OUT_PATH + '.new', csv, 'utf8'); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }

  console.log(`Wrote ${OUT_PATH} (${all.length} rows)`);
  console.log('Source breakdown:', JSON.stringify(counts, null, 2));
}

run().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
