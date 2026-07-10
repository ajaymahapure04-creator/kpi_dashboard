import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
(async function(){
  const client = new DBSQLClient();
  await client.connect({ host: process.env.DATABRICKS_HOST, path: process.env.DATABRICKS_PATH, token: process.env.DATABRICKS_TOKEN, telemetryEnabled: false });
  const session = await client.openSession();
  const tables = [
    'hive_metastore.datalake_prod.fact_main_oru4_prod',
    'hive_metastore.datalake_prod.fact_main_oru23_prod',
    'hive_metastore.datalake_prod.fact_main_orunext',
    'hive_metastore.datalake_int.fact_main_oru4_int'
  ];
  const out = {};
  for (const fq of tables) {
    try {
      const op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
      const r = await op.fetchAll();
      await op.close();
      const val = Array.isArray(r[0]) ? r[0][0] : (r[0].c || r[0].row_count || r[0['COUNT(*)']] || r[0['count(*)']] || r[0]);
      out[fq] = val;
    } catch (e) {
      out[fq] = { error: e.message || String(e) };
    }
  }
  await session.close();
  await client.close();
  console.log(JSON.stringify(out, null, 2));
})();
