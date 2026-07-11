import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

async function run() {
  const fq = 'hive_metastore.datalake_prod.fact_targeted_vehicles_oru4_prod';
  const host = process.env.DATABRICKS_HOST_EU || process.env.DATABRICKS_HOST;
  const path = process.env.DATABRICKS_PATH_EU || process.env.DATABRICKS_PATH;
  const token = process.env.DATABRICKS_TOKEN_EU || process.env.DATABRICKS_TOKEN;

  const client = new DBSQLClient();
  await client.connect({ host, path, token, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`DESCRIBE TABLE ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    console.log(`Columns for ${fq}:`);
    for (const r of rows) {
      // row may be array or object
      if (Array.isArray(r)) console.log('- ' + r[0]);
      else console.log('- ' + (r.col_name || Object.values(r)[0]));
    }
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(2);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
