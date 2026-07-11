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
    const sql = `SELECT COUNT(*) AS c FROM (
      SELECT brand, country_iso, campaign, date
      FROM ${fq}
      GROUP BY brand, country_iso, campaign, date
    ) t`;
    const op = await session.executeStatement(sql);
    const rows = await op.fetchAll();
    await op.close();
    const v = rows && rows[0] ? (Array.isArray(rows[0]) ? rows[0][0] : rows[0].c || rows[0]['COUNT(*)'] || rows[0]['count']) : 0;
    console.log(`${fq} grouped count => ${Number(v || 0)} groups`);
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(2);
  } finally {
    await session.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
