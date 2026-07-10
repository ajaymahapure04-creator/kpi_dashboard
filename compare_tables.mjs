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
const results = {};
for (const table of tables) {
  const fq = `hive_metastore.${schema}.${table}`;
  results[table] = { fq };
  try {
    const op1 = await session.executeStatement(`SELECT COUNT(*) AS row_count FROM ${fq}`);
    const cntRows = await op1.fetchAll();
    await op1.close();
    const cntRow = cntRows[0];
    const count = Array.isArray(cntRow) ? cntRow[0] : cntRow.row_count ?? cntRow['COUNT(*)'] ?? cntRow['count(*)'];
    results[table].count = count;
  } catch (err) {
    results[table].countError = err.message.replace(/\n/g, ' ');
  }

  try {
    const op2 = await session.executeStatement(`DESCRIBE ${fq}`);
    const descRows = await op2.fetchAll();
    await op2.close();
    // DESCRIBE returns rows like [col_name, data_type, comment]
    const cols = descRows.map(r => Array.isArray(r) ? r[0] : (r.col_name || r.name || Object.values(r)[0]));
    results[table].columns = cols;
  } catch (err) {
    results[table].describeError = err.message.replace(/\n/g, ' ');
  }

  try {
    const op3 = await session.executeStatement(`SELECT * FROM ${fq} LIMIT 1`);
    const sampleRows = await op3.fetchAll();
    await op3.close();
    const sample = sampleRows[0];
    if (Array.isArray(sample)) {
      results[table].sample = sample;
    } else if (sample && typeof sample === 'object') {
      results[table].sample = sample;
    } else {
      results[table].sample = null;
    }
  } catch (err) {
    results[table].sampleError = err.message.replace(/\n/g, ' ');
  }
}

console.log(JSON.stringify(results, null, 2));

await session.close();
await client.close();
