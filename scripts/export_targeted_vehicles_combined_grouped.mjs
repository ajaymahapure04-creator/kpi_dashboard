import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_NAME = 'fact_targeted_vehicles_combined_grouped.csv';
const OUT_PATH = path.join(DATA_DIR, OUT_NAME);

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

async function fetchRowsFor(tableFq, connectionConfig) {
  const client = new DBSQLClient();
  await client.connect(connectionConfig);
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT brand, country_iso, campaign, date, COALESCE(targeted_per_date,0) AS targeted_per_date FROM ${tableFq}`);
    const rows = await op.fetchAll();
    await op.close();
    return rows.map(r => Array.isArray(r) ? { brand: r[0], country_iso: r[1], campaign: r[2], date: r[3], targeted_per_date: Number(r[4] || 0) } : { brand: r.brand, country_iso: r.country_iso, campaign: r.campaign, date: r.date, targeted_per_date: Number(r.targeted_per_date || 0) });
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
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
  const euConfig = { host: process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN, telemetryEnabled: false };
  const uscaConfig = { host: process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_TOKEN, telemetryEnabled: false };

  const sources = [
    { fq: 'hive_metastore.datalake_prod.fact_targeted_vehicles_oru4_prod', tech: 'ORU4', config: euConfig },
    { fq: 'hive_metastore.datalake_prod.fact_targeted_vehicles_oru23_prod', tech: 'ORU23', config: euConfig },
    { fq: 'hive_metastore.datalake_int.fact_targeted_vehicles_oru4_int', tech: 'ORU4', config: uscaConfig },
  ];

  const allRows = [];
  for (const s of sources) {
    try {
      const fetched = await fetchRowsFor(s.fq, s.config);
      for (const r of fetched) {
        allRows.push({ brand: r.brand, country_iso: r.country_iso, campaign: r.campaign, date: r.date, Update_Technology: s.tech, targeted_per_date: Number(r.targeted_per_date || 0) });
      }
    } catch (err) {
      console.error(`Warning: could not fetch ${s.fq}:`, err && err.message ? err.message : err);
    }
  }

  // aggregate
  const map = new Map();
  for (const r of allRows) {
    const key = `${r.brand}|||${r.country_iso}|||${r.campaign}|||${r.date}|||${r.Update_Technology}`;
    const cur = map.get(key);
    if (cur) cur.targeted_total += Number(r.targeted_per_date || 0);
    else map.set(key, { brand: r.brand, country_iso: r.country_iso, campaign: r.campaign, date: r.date, Update_Technology: r.Update_Technology, targeted_total: Number(r.targeted_per_date || 0) });
  }

  const combined = Array.from(map.values());
  const csv = rowsToCsv(combined, ['brand','country_iso','campaign','date','Update_Technology','targeted_total']);

  const tmp = OUT_PATH + '.tmp';
  fs.writeFileSync(tmp, csv, 'utf8');
  try { fs.renameSync(tmp, OUT_PATH); }
  catch (e) { fs.writeFileSync(OUT_PATH + '.new', csv, 'utf8'); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }

  console.log(`Wrote ${OUT_PATH} (${combined.length} grouped rows)`);
}

run().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
