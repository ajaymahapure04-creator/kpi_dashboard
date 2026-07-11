import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

async function main() {
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_HOST_USCA, path: process.env.DATABRICKS_PATH_USCA, token: process.env.DATABRICKS_TOKEN_USCA, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    const value = rows[0] && (Array.isArray(rows[0]) ? rows[0][0] : rows[0].c || rows[0].COUNT || rows[0]['count(*)'] || rows[0]['COUNT(*)']);
    console.log(`${fq} -> ${Number(value || 0)} rows`);
  } catch (err) {
    console.error('Query failed:', err && err.message ? err.message : err);
    process.exitCode = 2;
  } finally {
    try { await session.close(); } catch (e) {}
    try { await client.close(); } catch (e) {}
  }
}

main();
