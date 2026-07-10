import dotenv from "dotenv";
import { DBSQLClient } from "@databricks/sql";

dotenv.config();
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST;
const path = process.env.DATABRICKS_PATH;
const token = process.env.DATABRICKS_TOKEN;
if (!host || !path || !token) throw new Error('Missing Databricks env vars');
await client.connect({ host, path, token, telemetryEnabled: false });
const session = await client.openSession();
const schema = 'datalake_prod';
const tables = ['fact_main_oru4_prod','fact_main_oru23_prod','fact_main_orunext'];
const canonical = [
  { name: 'campaign', type: 'STRING' },
  { name: 'brand', type: 'STRING' },
  { name: 'country_iso', type: 'STRING' },
  { name: 'wave', type: 'STRING' },
  { name: 'date', type: 'DATE' },
  { name: 'successful_updates', type: 'BIGINT' },
  { name: 'quality', type: 'BIGINT' },
  { name: 'downtime_minutes', type: 'BIGINT' },
  { name: 'update_operations', type: 'BIGINT' },
  { name: 'lb_common_vehicles', type: 'BIGINT' },
  { name: 'lb_backend_vehicles', type: 'BIGINT' },
  { name: 'lb_aftersales_vehicles', type: 'BIGINT' },
  { name: 'cost_savings', type: 'DOUBLE' },
  { name: 'co2_savings', type: 'DOUBLE' },
  { name: 'platform', type: 'STRING' },
  { name: 'update_technology', type: 'STRING' },
  { name: 'customerWarning_none', type: 'BIGINT' },
  { name: 'customerWarning_minor', type: 'BIGINT' },
  { name: 'customerWarning_major', type: 'BIGINT' }
];
const out = {};
for (const table of tables) {
  const fq = `hive_metastore.${schema}.${table}`;
  out[table] = { fq };
  try {
    // get column set
    const descOp = await session.executeStatement(`DESCRIBE ${fq}`);
    const descRows = await descOp.fetchAll();
    await descOp.close();
    const cols = new Set(descRows.map(r => Array.isArray(r) ? r[0] : (r.col_name || Object.values(r)[0])));

    // build select list
    const parts = canonical.map(col => {
      if (cols.has(col.name)) return `CAST(${col.name} AS ${col.type}) AS ${col.name}`;
      return `CAST(NULL AS ${col.type}) AS ${col.name}`;
    });

    const countOp = await session.executeStatement(`SELECT COUNT(*) AS row_count FROM ${fq}`);
    const cntRows = await countOp.fetchAll();
    await countOp.close();
    const cntRow = cntRows[0];
    const count = Array.isArray(cntRow) ? cntRow[0] : cntRow.row_count ?? cntRow['COUNT(*)'] ?? cntRow['count(*)'];
    out[table].count = count;

    const q = `SELECT ${parts.join(', ')} FROM ${fq} LIMIT 3`;
    const sampleOp = await session.executeStatement(q);
    const sampleRows = await sampleOp.fetchAll();
    await sampleOp.close();
    out[table].preview = sampleRows.map(r => {
      if (Array.isArray(r)) return r; // fallback
      return r;
    });
  } catch (err) {
    out[table].error = err.message.replace(/\n/g,' ');
  }
}
console.log(JSON.stringify(out, null, 2));
await session.close();
await client.close();
