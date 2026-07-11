import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_NAME = 'fact_targeted_vehicles_oru4_grouped.csv';
const OUT_PATH = path.join(DATA_DIR, OUT_NAME);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function rowsToCsv(rows, headers) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const hdr = headers.join(',') + '\n';
  const lines = rows.map(r => headers.map(h => escape(r[h])).join(','));
  return hdr + lines.join('\n') + '\n';
}

async function run() {
  ensureDataDir();
  const fq = 'hive_metastore.datalake_prod.fact_targeted_vehicles_oru4_prod';
  const config = {
    host: process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST,
    path: process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH,
    token: process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN,
  };
  const client = new DBSQLClient();
  await client.connect({ host: config.host, path: config.path, token: config.token, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const sql = `SELECT brand, country_iso, campaign, date, SUM(COALESCE(targeted_per_date,0)) AS targeted_total\nFROM ${fq}\nGROUP BY brand, country_iso, campaign, date`;
    const op = await session.executeStatement(sql);
    const rows = await op.fetchAll();
    await op.close();
    const parsed = rows.map((r) => {
      if (Array.isArray(r)) return { brand: r[0], country_iso: r[1], campaign: r[2], date: r[3], targeted_total: r[4] };
      return r;
    });

    const csv = rowsToCsv(parsed, ['brand','country_iso','campaign','date','targeted_total']);

    // atomic write
    const tmp = OUT_PATH + '.tmp';
    fs.writeFileSync(tmp, csv, { encoding: 'utf8' });
    try { fs.renameSync(tmp, OUT_PATH); }
    catch (e) {
      // fallback: write .new
      fs.writeFileSync(OUT_PATH + '.new', csv, { encoding: 'utf8' });
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    console.log(`Wrote ${OUT_PATH} (${parsed.length} rows)`);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

run().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
