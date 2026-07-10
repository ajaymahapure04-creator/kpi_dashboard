import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async ()=>{
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  try {
    const op = await session.executeStatement(`SELECT country_iso, COUNT(*) AS c FROM ${fq} GROUP BY country_iso ORDER BY c DESC LIMIT 200`);
    const rows = await op.fetchAll(); await op.close();
    console.log('country_breakdown:', JSON.stringify(rows.map(r=>Array.isArray(r)?{country_iso:r[0],count:r[1]}:r), null, 2));

    const op2 = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq} WHERE country_iso IN ('US','CA','MX')`);
    const r2 = await op2.fetchAll(); await op2.close();
    console.log('NA_total:', JSON.stringify(r2[0]));
  } catch (e) {
    console.error('ERROR', e.message || e);
  } finally {
    await session.close();
    await client.close();
  }
})();
