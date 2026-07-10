import dotenv from "dotenv";
import { DBSQLClient } from "@databricks/sql";

dotenv.config();
const tableArg = process.argv[2] || 'fact_main_orunext';
const schema = process.argv[3] || 'datalake_prod';
const fq = `hive_metastore.${schema}.${tableArg}`;
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST;
const path = process.env.DATABRICKS_PATH;
const token = process.env.DATABRICKS_TOKEN;
if (!host || !path || !token) {
  throw new Error('Missing Databricks env vars');
}
await client.connect({ host, path, token, telemetryEnabled: false });
const session = await client.openSession();
try {
  console.log(`Querying ${fq} ...`);
  const op = await session.executeStatement(`SELECT COUNT(*) AS row_count FROM ${fq}`);
  const rows = await op.fetchAll();
  await op.close();
  const row = rows[0];
  const count = Array.isArray(row) ? row[0] : row.row_count ?? row['COUNT(*)'] ?? row['count(*)'];
  console.log(`${fq}: ${count}`);
  const op2 = await session.executeStatement(`SELECT * FROM ${fq} LIMIT 1`);
  const sample = await op2.fetchAll();
  await op2.close();
  console.log('Sample row:', JSON.stringify(sample[0] ?? null, null, 2));
} catch (err) {
  console.error(`${fq}: ERROR: ${err.message.replace(/\n/g, ' ')}`);
  process.exitCode = 2;
} finally {
  await session.close();
  await client.close();
}
