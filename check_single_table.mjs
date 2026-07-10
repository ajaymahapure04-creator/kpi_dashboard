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
const table = 'fact_main_oru4_prod';
const fq = `hive_metastore.${schema}.${table}`;
try {
  console.log(`Querying ${fq} ...`);
  const op = await session.executeStatement(`SELECT COUNT(*) AS row_count FROM ${fq}`);
  const rows = await op.fetchAll();
  await op.close();
  const row = rows[0];
  const count = Array.isArray(row) ? row[0] : row.row_count ?? row['COUNT(*)'] ?? row['count(*)'];
  console.log(`${fq}: ${count}`);
} catch (err) {
  console.error(`${fq}: ERROR: ${err.message.replace(/\n/g, ' ')}`);
  process.exitCode = 2;
} finally {
  await session.close();
  await client.close();
}
