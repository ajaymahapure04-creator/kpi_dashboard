import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async () => {
  const client = new DBSQLClient();
  // connect via PROD host but query the datalake_int schema (works in previous checks)
  await client.connect({ host: process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  const out = {};
  try {
    const totalOp = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const totalR = await totalOp.fetchAll(); await totalOp.close();
    out.total = Array.isArray(totalR[0]) ? totalR[0][0] : (totalR[0].c || totalR[0].row_count || totalR[0]);

    const techOp = await session.executeStatement(`SELECT update_technology, COUNT(*) AS c FROM ${fq} GROUP BY update_technology ORDER BY c DESC LIMIT 100`);
    const techR = await techOp.fetchAll(); await techOp.close();
    out.by_update_technology = techR.map(r => Array.isArray(r) ? { update_technology: r[0], count: r[1] } : r);

    const platOp = await session.executeStatement(`SELECT platform, COUNT(*) AS c FROM ${fq} GROUP BY platform ORDER BY c DESC LIMIT 100`);
    const platR = await platOp.fetchAll(); await platOp.close();
    out.by_platform = platR.map(r => Array.isArray(r) ? { platform: r[0], count: r[1] } : r);

    const brandOp = await session.executeStatement(`SELECT brand, COUNT(*) AS c FROM ${fq} GROUP BY brand ORDER BY c DESC LIMIT 50`);
    const brandR = await brandOp.fetchAll(); await brandOp.close();
    out.top_brands = brandR.map(r => Array.isArray(r) ? { brand: r[0], count: r[1] } : r);

    const platformOru4Op = await session.executeStatement(`SELECT platform, update_technology, COUNT(*) AS c FROM ${fq} GROUP BY platform, update_technology ORDER BY c DESC LIMIT 200`);
    const poru4R = await platformOru4Op.fetchAll(); await platformOru4Op.close();
    out.by_platform_and_tech = poru4R.map(r => Array.isArray(r) ? { platform: r[0], update_technology: r[1], count: r[2] } : r);

    // sample campaign counts for small campaigns
    const campOp = await session.executeStatement(`SELECT campaign, COUNT(*) AS c FROM ${fq} GROUP BY campaign ORDER BY c ASC LIMIT 50`);
    const campR = await campOp.fetchAll(); await campOp.close();
    out.smallest_campaigns = campR.map(r => Array.isArray(r) ? { campaign: r[0], count: r[1] } : r);

    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('ERROR', e.message || e);
  } finally {
    await session.close();
    await client.close();
  }
})();
