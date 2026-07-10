import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async () => {
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const fq = 'hive_metastore.datalake_int.fact_main_oru4_int';
  const out = {};
  try {
    const totalOp = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const totalR = await totalOp.fetchAll(); await totalOp.close();
    out.total = Array.isArray(totalR[0]) ? totalR[0][0] : (totalR[0].c || totalR[0].row_count || totalR[0]);

    const techOp = await session.executeStatement(`SELECT update_technology, COUNT(*) AS c FROM ${fq} GROUP BY update_technology ORDER BY c DESC LIMIT 50`);
    const techR = await techOp.fetchAll(); await techOp.close();
    out.by_update_technology = techR.map(r => Array.isArray(r) ? { update_technology: r[0], count: r[1] } : r);

    const platOp = await session.executeStatement(`SELECT platform, COUNT(*) AS c FROM ${fq} GROUP BY platform ORDER BY c DESC LIMIT 50`);
    const platR = await platOp.fetchAll(); await platOp.close();
    out.by_platform = platR.map(r => Array.isArray(r) ? { platform: r[0], count: r[1] } : r);

    const brandOp = await session.executeStatement(`SELECT brand, COUNT(*) AS c FROM ${fq} GROUP BY brand ORDER BY c DESC LIMIT 20`);
    const brandR = await brandOp.fetchAll(); await brandOp.close();
    out.top_brands = brandR.map(r => Array.isArray(r) ? { brand: r[0], count: r[1] } : r);

    const recentOp = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq} WHERE date >= DATE('2026-01-01')`);
    const recentR = await recentOp.fetchAll(); await recentOp.close();
    out.since_2026_01_01 = Array.isArray(recentR[0]) ? recentR[0][0] : (recentR[0].c || recentR[0]);

    const oru4Op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq} WHERE update_technology ILIKE '%ORU4%'`);
    const oru4R = await oru4Op.fetchAll(); await oru4Op.close();
    out.oru4_like = Array.isArray(oru4R[0]) ? oru4R[0][0] : (oru4R[0].c || oru4R[0]);

    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('ERROR', e.message || e);
  } finally {
    await session.close();
    await client.close();
  }
})();
