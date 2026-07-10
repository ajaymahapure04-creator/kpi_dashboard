import dotenv from "dotenv";
import { DBSQLClient } from "@databricks/sql";

dotenv.config();
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST;
const path = process.env.DATABRICKS_PATH;
const token = process.env.DATABRICKS_TOKEN;
if (!host || !path || !token) {
  throw new Error('Missing Databricks env vars');
}
await client.connect({ host, path, token, telemetryEnabled: false });
const session = await client.openSession();
const schema = 'datalake_prod';
const tables = ['fact_main_oru4_prod', 'fact_main_oru23_prod'];
const out = {};
for (const table of tables) {
  const fq = `hive_metastore.${schema}.${table}`;
  try {
    const op = await session.executeStatement(`DESCRIBE ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    // rows are arrays like [col_name, data_type, comment]
    out[table] = rows.map(r => Array.isArray(r) ? { name: r[0], type: r[1], comment: r[2] } : r);
  } catch (err) {
    out[table] = { error: err.message.replace(/\n/g, ' ') };
  }
}
console.log(JSON.stringify(out, null, 2));
await session.close();
await client.close();
