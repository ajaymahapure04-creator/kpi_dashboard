import dotenv from "dotenv";
import { DBSQLClient } from "@databricks/sql";

dotenv.config();
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST;
const path = process.env.DATABRICKS_PATH;
const token = process.env.DATABRICKS_TOKEN;
if (!host || !path || !token) {
  throw new Error('Missing Databricks env vars');
}
await client.connect({ host, path, token, telemetryEnabled: false });
const session = await client.openSession();
const schemas = ['hive_metastore.datalake_int', 'hive_metastore.datalake_dev'];
const tables = ['fact_targeted_vehicles_oru23', 'fact_targeted_vehicles_oru4_nar', 'fact_adoption_rate_oru23', 'fact_adoption_rate_oru4_nar', 'fact_ecu_oru23', 'fact_release_oru23', 'fact_release_oru4_nar', 'dim_campaign_oru23', 'dim_campaign_oru4_nar', 'dim_country_oru23_dev', 'dim_country_oru4_nar', 'fact_ai_summaries_facts_v3_int'];
for (const schema of schemas) {
  console.log(`\n=== ${schema} ===`);
  for (const table of tables) {
    const fq = `${schema}.${table}`;
    try {
      const op = await session.executeStatement(`SELECT COUNT(*) AS row_count FROM ${fq}`);
      const rows = await op.fetchAll();
      await op.close();
      const row = rows[0];
      const count = Array.isArray(row) ? row[0] : row.row_count ?? row['COUNT(*)'] ?? row['count(*)'];
      console.log(`${table}: ${count}`);
    } catch (err) {
      console.log(`${table}: ERROR: ${err.message.replace(/\n/g, ' ')}`);
    }
  }
}
await session.close();
await client.close();
