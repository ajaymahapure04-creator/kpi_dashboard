import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

async function countExact(fq, host, path, token) {
  const client = new DBSQLClient();
  await client.connect({ host, path, token, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    const value = rows[0] && (Array.isArray(rows[0]) ? rows[0][0] : rows[0].c || rows[0].COUNT || rows[0]['count(*)'] || rows[0]['COUNT(*)']);
    console.log(`${fq} => ${Number(value || 0)} rows`);
  } catch (err) {
    console.error(`${fq} ERROR:`, err && err.message ? err.message : err);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

async function main() {
  await countExact(
    'hive_metastore.datalake_prod.fact_targeted_vehicles_oru23_prod',
    process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST,
    process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH,
    process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN
  );
  await countExact(
    'hive_metastore.datalake_int.fact_targeted_vehicles_oru4_int',
    process.env.DATABRICKS_HOST_USCA,
    process.env.DATABRICKS_PATH_USCA,
    process.env.DATABRICKS_TOKEN_USCA
  );
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
