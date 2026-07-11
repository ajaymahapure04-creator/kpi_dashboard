import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

function envOr(key, altKey) {
  return process.env[key] || process.env[altKey];
}

function getTableCandidates() {
  const PROD_SCHEMA = process.env.DATALAKE_PROD_SCHEMA || 'hive_metastore.datalake_prod';
  const INT_SCHEMA = process.env.DATALAKE_INT_SCHEMA || 'hive_metastore.datalake_int';
  const DEV_SCHEMA = process.env.DATALAKE_DEV_SCHEMA || 'hive_metastore.datalake_dev';
  return [
    { schema: PROD_SCHEMA, connection: 'prod' },
    { schema: PROD_SCHEMA, connection: 'usca' },
    { schema: INT_SCHEMA, connection: 'int' },
    { schema: DEV_SCHEMA, connection: 'int' },
  ];
}

function getDatabricksConfig(connection = 'prod') {
  switch (connection) {
    case 'int':
      return {
        host: process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST,
        path: process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH,
        token: process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN,
      };
    case 'usca':
      return {
        host: process.env.DATABRICKS_HOST_USCA || process.env.DATABRICKS_INT_HOST || process.env.DATABRICKS_HOST,
        path: process.env.DATABRICKS_PATH_USCA || process.env.DATABRICKS_INT_PATH || process.env.DATABRICKS_PATH,
        token: process.env.DATABRICKS_TOKEN_USCA || process.env.DATABRICKS_INT_TOKEN || process.env.DATABRICKS_TOKEN,
      };
    default:
      return {
        host: process.env.DATABRICKS_HOST || process.env.DATABRICKS_HOST_EU,
        path: process.env.DATABRICKS_PATH || process.env.DATABRICKS_PATH_EU,
        token: process.env.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN_EU,
      };
  }
}

async function openDatabricksSession(connection = 'prod') {
  const config = getDatabricksConfig(connection);
  const client = new DBSQLClient();
  await client.connect({ host: config.host, path: config.path, token: config.token, telemetryEnabled: false });
  const session = await client.openSession();
  return { client, session };
}

async function countFq(fq, connection) {
  const { client, session } = await openDatabricksSession(connection);
  try {
    const op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    const v = rows[0] && (Array.isArray(rows[0]) ? rows[0][0] : rows[0].c || rows[0].COUNT || rows[0]['count(*)'] || rows[0]['COUNT(*)']);
    return Number(v || 0);
  } finally {
    try { await session.close(); } catch (e) {}
    try { await client.close(); } catch (e) {}
  }
}

async function countAgainstFirstAvailable(name) {
  const candidates = getTableCandidates();
  for (const c of candidates) {
    const fq = `${c.schema}.${name}`;
    try {
      const cnt = await countFq(fq, c.connection);
      return { found: true, fq, connection: c.connection, count: cnt };
    } catch (err) {
      // ignore and try next candidate
    }
  }
  return { found: false };
}

const TABLES = [
  'fact_main_oru4_prod', 'fact_main_oru23_prod', 'fact_main_oru4_nar', 'fact_main_orunext', 'fact_main_oru4_int',
  'fact_targeted_vehicles_oru4_prod', 'fact_targeted_vehicles_oru23', 'fact_targeted_vehicles_oru4_nar',
  'fact_adoption_rate_oru4_prod', 'fact_adoption_rate_oru23', 'fact_adoption_rate_oru4_nar', 'fact_adoption_rate_oru4_int',
  'fact_ecu_oru4_prod', 'fact_ecu_oru23', 'fact_ecu_oru23_prod',
  'fact_release_oru4_prod', 'fact_release_oru23', 'fact_release_oru4_nar',
  'dim_campaign_oru4_prod', 'dim_campaign_oru23', 'dim_campaign_oru4_nar', 'dim_campaign_orunext', 'dim_campaign_oru4_int', 'dim_campaign_oru23_prod', 'dim_campaign_oru234chn_oru23nar',
  'dim_country_oru4_prod', 'dim_country_oru23_dev', 'dim_country_oru234chn_oru23nar', 'dim_country_oru4_nar', 'dim_country_oru23_prod', 'dim_country_oru4_int',
  'fact_ai_summaries_facts_v3_int'
];

async function main() {
  const results = {};
  for (const t of TABLES) {
    process.stdout.write(`Checking ${t} ... `);
    try {
      const res = await countAgainstFirstAvailable(t);
      if (res.found) {
        console.log(`${res.count} rows (${res.fq} @ ${res.connection})`);
        results[t] = { count: res.count, fq: res.fq, connection: res.connection };
      } else {
        console.log('not found in candidates');
        results[t] = { found: false };
      }
    } catch (err) {
      console.log('error:', err && err.message ? err.message : err);
      results[t] = { error: err && err.message ? err.message : String(err) };
    }
  }
  console.log('\nSummary:\n' + JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
