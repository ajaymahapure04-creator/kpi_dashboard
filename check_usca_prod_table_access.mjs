import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
const client = new DBSQLClient();
await client.connect({
  host: process.env.DATABRICKS_HOST_USCA,
  path: process.env.DATABRICKS_PATH_USCA,
  token: process.env.DATABRICKS_TOKEN_USCA,
  telemetryEnabled: false,
});
const session = await client.openSession();
try {
  console.log('Checking table visibility for hive_metastore.datalake_prod...');
  const listOp = await session.executeStatement('SHOW TABLES IN hive_metastore.datalake_prod');
  const listRows = await listOp.fetchAll();
  await listOp.close();
  console.log('SHOW TABLES result count:', listRows.length);
  console.log(listRows.slice(0, 20).map(r => Array.isArray(r) ? r : r));

  console.log('\nChecking direct access to fact_main_oru4_prod...');
  const countOp = await session.executeStatement('SELECT COUNT(*) AS c FROM hive_metastore.datalake_prod.fact_main_oru4_prod');
  const countRows = await countOp.fetchAll();
  await countOp.close();
  console.log('COUNT result:', JSON.stringify(countRows[0]));
} catch (err) {
  console.error('ERROR', err.message || err);
} finally {
  await session.close();
  await client.close();
}
