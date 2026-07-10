import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async () => {
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  try {
    const countOp = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const countRows = await countOp.fetchAll(); await countOp.close();
    const total = Array.isArray(countRows[0]) ? countRows[0][0] : (countRows[0].c || countRows[0].row_count || countRows[0]);

    const countryOp = await session.executeStatement(`SELECT country_iso, COUNT(*) AS c FROM ${fq} GROUP BY country_iso ORDER BY c DESC LIMIT 200`);
    const countryRows = await countryOp.fetchAll(); await countryOp.close();
    const countries = countryRows.map(r => Array.isArray(r) ? { country_iso: r[0], count: r[1]} : r);

    const detailOp = await session.executeStatement(`DESCRIBE DETAIL ${fq}`);
    const detailRows = await detailOp.fetchAll(); await detailOp.close();

    console.log(JSON.stringify({ total, countries, detailRows }, null, 2));
  } catch (err) {
    console.error('ERROR', err.message || err);
  } finally {
    await session.close();
    await client.close();
  }
})();
