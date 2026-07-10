import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

const PROD_SCHEMA = process.env.DATALAKE_PROD_SCHEMA || 'hive_metastore.datalake_prod';
const INT_SCHEMA = process.env.DATALAKE_INT_SCHEMA || 'hive_metastore.datalake_int';

const prodConfig = {
  host: process.env.DATABRICKS_HOST || process.env.DATABRICKS_HOST_EU,
  path: process.env.DATABRICKS_PATH || process.env.DATABRICKS_PATH_EU,
  token: process.env.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN_EU,
};
const intConfig = {
  host: process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_INT_HOST,
  path: process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_INT_PATH,
  token: process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_INT_TOKEN,
};

function buildFullName(schema, table) {
  return `${schema}.${table}`;
}

async function connect(config) {
  const client = new DBSQLClient();
  await client.connect({ host: config.host, path: config.path, token: config.token, telemetryEnabled: false });
  return client;
}

async function countTable(client, schema, table) {
  const session = await client.openSession();
  try {
    const fullName = buildFullName(schema, table);
    const op = await session.executeStatement(`SELECT COUNT(*) AS cnt FROM ${fullName}`);
    const rows = await op.fetchAll();
    await op.close();
    const row = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
    return row.cnt ?? row.COUNT ?? row['count(*)'] ?? row['COUNT(*)'];
  } finally {
    await session.close();
  }
}

async function main() {
  const prodClient = await connect(prodConfig);
  const intClient = await connect(intConfig);
  const counts = {};

  const tableGroups = {
    fact_main: [
      { name: 'fact_main_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_main_oru23', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_main_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_main_orunext', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_main_oru4_int', schema: INT_SCHEMA, client: intClient },
    ],
    fact_adoption_rate: [
      { name: 'fact_adoption_rate_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_adoption_rate_oru23', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_adoption_rate_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
    ],
    fact_ecu: [
      { name: 'fact_ecu_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_ecu_oru23', schema: PROD_SCHEMA, client: prodClient },
    ],
    fact_frequency: [
      { name: 'fact_frequency_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_frequency_oru23_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_frequency_oru4_int', schema: INT_SCHEMA, client: intClient },
    ],
    fact_release: [
      { name: 'fact_release_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_release_oru23', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_release_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
    ],
    fact_targeted_vehicles: [
      { name: 'fact_targeted_vehicles_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_targeted_vehicles_oru23', schema: PROD_SCHEMA, client: prodClient },
      { name: 'fact_targeted_vehicles_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
    ],
    dim_campaign: [
      { name: 'dim_campaign_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_campaign_oru23', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_campaign_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_campaign_orunext', schema: PROD_SCHEMA, client: prodClient },
    ],
    dim_country: [
      { name: 'dim_country_oru4_prod', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_country_oru23_dev', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_country_oru234chn_oru23nar', schema: PROD_SCHEMA, client: prodClient },
      { name: 'dim_country_oru4_nar', schema: PROD_SCHEMA, client: prodClient },
    ],
  };

  for (const [group, tables] of Object.entries(tableGroups)) {
    counts[group] = [];
    for (const t of tables) {
      try {
        const cnt = await countTable(t.client, t.schema, t.name);
        counts[group].push({ table: t.name, row_count: cnt });
      } catch (error) {
        counts[group].push({ table: t.name, error: error.message });
      }
    }
  }

  console.log(JSON.stringify(counts, null, 2));
  await prodClient.close();
  await intClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});