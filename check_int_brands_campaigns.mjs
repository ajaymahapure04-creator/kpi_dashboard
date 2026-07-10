import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async ()=>{
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  try {
    const bOp = await session.executeStatement(`SELECT brand, COUNT(*) AS c FROM ${fq} GROUP BY brand ORDER BY c DESC LIMIT 50`);
    const bR = await bOp.fetchAll(); await bOp.close();
    console.log('top_brands:', JSON.stringify(bR.map(r=>Array.isArray(r)?{brand:r[0],count:r[1]}:r), null, 2));

    const cOp = await session.executeStatement(`SELECT campaign, COUNT(*) AS c FROM ${fq} GROUP BY campaign ORDER BY c DESC LIMIT 50`);
    const cR = await cOp.fetchAll(); await cOp.close();
    console.log('top_campaigns:', JSON.stringify(cR.map(r=>Array.isArray(r)?{campaign:r[0],count:r[1]}:r), null, 2));

    const dateOp = await session.executeStatement(`SELECT YEAR(date) as yr, COUNT(*) AS c FROM ${fq} GROUP BY YEAR(date) ORDER BY yr DESC`);
    const dateR = await dateOp.fetchAll(); await dateOp.close();
    console.log('by_year:', JSON.stringify(dateR.map(r=>Array.isArray(r)?{year:r[0],count:r[1]}:r), null, 2));
  } catch (e) {
    console.error('ERROR', e.message || e);
  } finally {
    await session.close();
    await client.close();
  }
})();
