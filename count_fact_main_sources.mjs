import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();

function envOr(key, altKey) {
  return process.env[key] || process.env[altKey];
}

async function countTable({ host, path, token, fq }) {
  const client = new DBSQLClient();
  await client.connect({ host, path, token, telemetryEnabled: false });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(`SELECT COUNT(*) AS c FROM ${fq}`);
    const rows = await op.fetchAll();
    await op.close();
    const value = rows[0] && (Array.isArray(rows[0]) ? rows[0][0] : rows[0].c || rows[0].COUNT || rows[0]['count(*)'] || rows[0]['COUNT(*)']);
    return Number(value);
  } finally {
    await session.close();
    await client.close();
  }
}

async function main() {
  const euConn = {
    host: envOr('DATABRICKS_HOST_EU', 'DATABRICKS_HOST'),
    path: envOr('DATABRICKS_PATH_EU', 'DATABRICKS_PATH'),
    token: envOr('DATABRICKS_TOKEN_EU', 'DATABRICKS_TOKEN'),
  };
  const uscaConn = {
    host: process.env.DATABRICKS_HOST_USCA,
    path: process.env.DATABRICKS_PATH_USCA,
    token: process.env.DATABRICKS_TOKEN_USCA,
  };

  const tables = [
    { label: 'EU.fact_main_oru4_prod', fq: 'hive_metastore.datalake_prod.fact_main_oru4_prod', conn: euConn },
    { label: 'EU.fact_main_oru23_prod', fq: 'hive_metastore.datalake_prod.fact_main_oru23_prod', conn: euConn },
    { label: 'EU.fact_main_orunext', fq: 'hive_metastore.datalake_prod.fact_main_orunext', conn: euConn },
    { label: 'USCA.fact_main_oru4_prod', fq: 'hive_metastore.datalake_prod.fact_main_oru4_prod', conn: uscaConn },
  ];

  const results = {};
  let total = 0;
  for (const item of tables) {
    if (!item.conn.host || !item.conn.path || !item.conn.token) {
      results[item.label] = { error: 'Missing connection settings' };
      continue;
    }
    try {
      const count = await countTable({ ...item.conn, fq: item.fq });
      results[item.label] = count;
      total += count;
    } catch (err) {
      results[item.label] = { error: err.message || String(err) };
    }
  }
  results.total = total;
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});