import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
const client = new DBSQLClient();
await client.connect({
  host: process.env.DATABRICKS_HOST_EU,
  path: process.env.DATABRICKS_PATH_EU,
  token: process.env.DATABRICKS_TOKEN_EU,
  telemetryEnabled: false,
});
const session = await client.openSession();
try {
  const fq = 'hive_metastore.datalake_prod.fact_main_oru4_prod';
  const countOp = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
  const countRows = await countOp.fetchAll();
  await countOp.close();
  console.log('count', JSON.stringify(countRows[0]));
  const countryOp = await session.executeStatement(`SELECT country_iso, COUNT(*) AS c FROM ${fq} GROUP BY country_iso ORDER BY c DESC LIMIT 50`);
  const countryRows = await countryOp.fetchAll();
  await countryOp.close();
  console.log('countries', JSON.stringify(countryRows.map(r => Array.isArray(r) ? { country_iso: r[0], count: r[1] } : r), null, 2));
} catch (err) {
  console.error('ERROR', err.message || err);
} finally {
  await session.close();
  await client.close();
}
