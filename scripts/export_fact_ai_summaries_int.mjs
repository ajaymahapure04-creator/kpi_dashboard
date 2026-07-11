import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_NAME = 'fact_ai_summaries_facts_v3_int.csv';
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

async function run() {
  ensureDataDir();
  const fq = 'hive_metastore.datalake_int.fact_ai_summaries_facts_v3_int';
  // use EU host/path as requested
  const config = {
    host: process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST,
    path: process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH,
    token: process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN,
    telemetryEnabled: false,
  };

  const client = new DBSQLClient();
  await client.connect({ host: config.host, path: config.path, token: config.token, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT * FROM ${fq} WHERE generated_at = (SELECT MAX(generated_at) FROM ${fq})`);
    const rows = await op.fetchAll();
    await op.close();
    const parsed = rows.map(r => Array.isArray(r) ? Object.assign({}, r) : r);
    const csv = rowsToCsv(parsed);
    if (!csv) {
      console.log('No rows returned; wrote empty CSV with header only.');
    }
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, csv, 'utf8');
    try { fs.renameSync(tmp, OUT_PATH); }
    catch (e) { fs.writeFileSync(OUT_PATH + '.new', csv, 'utf8'); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    console.log(`Wrote ${OUT_PATH} (${parsed.length} rows)`);
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(2);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

run().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
