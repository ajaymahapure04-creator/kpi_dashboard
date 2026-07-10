import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST;
const path = process.env.DATABRICKS_PATH;
const token = process.env.DATABRICKS_TOKEN;
if (!host || !path || !token) throw new Error('Missing Databricks env vars');
await client.connect({ host, path, token, telemetryEnabled: false });
const session = await client.openSession();
const schema = 'datalake_prod';
const viewName = 'fact_main';
const fqView = `hive_metastore.${schema}.${viewName}`;

const cols = [
  'campaign', 'brand', 'country_iso', 'wave', 'date', 'successful_updates',
  'quality', 'downtime_minutes', 'update_operations', 'lb_common_vehicles',
  'lb_backend_vehicles', 'lb_aftersales_vehicles', 'cost_savings', 'co2_savings',
  'platform', 'update_technology', 'customerWarning_none', 'customerWarning_minor', 'customerWarning_major'
];

const cast = (col) => {
  switch (col) {
    case 'date': return `CAST(${col} AS DATE) AS ${col}`;
    case 'successful_updates':
    case 'quality':
    case 'downtime_minutes':
    case 'update_operations':
    case 'lb_common_vehicles':
    case 'lb_backend_vehicles':
    case 'lb_aftersales_vehicles':
    case 'customerWarning_none':
    case 'customerWarning_minor':
    case 'customerWarning_major':
      return `CAST(${col} AS BIGINT) AS ${col}`;
    case 'cost_savings':
    case 'co2_savings':
      return `CAST(${col} AS DOUBLE) AS ${col}`;
    default:
      return `CAST(${col} AS STRING) AS ${col}`;
  }
};

const sources = ['fact_main_oru4_prod','fact_main_oru23_prod','fact_main_orunext','fact_main_oru4_int'];
const selects = sources.map(s => {
  const fq = `hive_metastore.${schema}.${s}`;
  const parts = cols.map(col => `${cols.includes(col) ? `CASE WHEN (SELECT 1 FROM (SELECT 1) tmp) IS NOT NULL THEN ${col} END` : 'NULL'}`);
  // Instead of the above placeholder, build per-col expression: if column exists then cast(col) else cast(NULL AS type)
  const perCol = cols.map(col => `CASE WHEN (SELECT 1 FROM (DESCRIBE ${fq}) d WHERE d.col_name = '${col}') IS NOT NULL THEN ${col} ELSE NULL END`);
  // The above dynamic DESCRIBE in SELECT isn't supported. We'll instead select using TRY_CAST pattern: use `CAST(${col} AS TYPE)` — if column missing, query will fail. So we need to be explicit per source.
  return null;
});

// Because runtime column-existence checks aren't straightforward in a single SQL statement,
// build each SELECT explicitly with available columns and NULLs for missing ones.

const buildSelect = async (table) => {
  // If the table name indicates an INT source, read from the int schema
  const sourceSchema = table.endsWith('_int') ? 'datalake_int' : schema;
  const fq = `hive_metastore.${sourceSchema}.${table}`;
  // get existing columns
  const op = await session.executeStatement(`DESCRIBE ${fq}`);
  const rows = await op.fetchAll();
  await op.close();
  const existing = new Set(rows.map(r => Array.isArray(r) ? r[0] : (r.col_name || Object.values(r)[0])));
  const parts = cols.map(col => {
    if (existing.has(col)) {
      // produce cast expression
      switch (col) {
        case 'date': return `CAST(${col} AS DATE) AS ${col}`;
        case 'successful_updates':
        case 'quality':
        case 'downtime_minutes':
        case 'update_operations':
        case 'lb_common_vehicles':
        case 'lb_backend_vehicles':
        case 'lb_aftersales_vehicles':
        case 'customerWarning_none':
        case 'customerWarning_minor':
        case 'customerWarning_major':
          return `CAST(${col} AS BIGINT) AS ${col}`;
        case 'cost_savings':
        case 'co2_savings':
          return `CAST(${col} AS DOUBLE) AS ${col}`;
        default:
          return `CAST(${col} AS STRING) AS ${col}`;
      }
    }
    // missing column -> NULL cast
    switch (col) {
      case 'date': return `CAST(NULL AS DATE) AS ${col}`;
      case 'successful_updates':
      case 'quality':
      case 'downtime_minutes':
      case 'update_operations':
      case 'lb_common_vehicles':
      case 'lb_backend_vehicles':
      case 'lb_aftersales_vehicles':
      case 'customerWarning_none':
      case 'customerWarning_minor':
      case 'customerWarning_major':
        return `CAST(NULL AS BIGINT) AS ${col}`;
      case 'cost_savings':
      case 'co2_savings':
        return `CAST(NULL AS DOUBLE) AS ${col}`;
      default:
        return `CAST(NULL AS STRING) AS ${col}`;
    }
  });
  return `SELECT ${parts.join(', ')} FROM ${fq}`;
};

try {
  const selectsBuilt = [];
  for (const s of sources) {
    try {
      const sel = await buildSelect(s);
      selectsBuilt.push(sel);
    } catch (err) {
      // table might not exist — skip
      console.warn(`Skipping ${s}: ${err.message}`);
    }
  }
  if (selectsBuilt.length === 0) throw new Error('No source tables found to build view');
  const unionSql = selectsBuilt.join('\nUNION ALL\n');
  const createSql = `CREATE OR REPLACE VIEW ${fqView} AS\n${unionSql}`;
  console.log('Creating view with SQL:\n', createSql);
  const opCreate = await session.executeStatement(createSql);
  await opCreate.fetchAll();
  await opCreate.close();
  console.log(`View ${fqView} created or replaced successfully.`);
} catch (err) {
  console.error('Failed to create view:', err.message || err);
  process.exitCode = 2;
} finally {
  await session.close();
  await client.close();
}
