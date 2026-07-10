import dotenv from 'dotenv';
import { DBSQLClient } from '@databricks/sql';

dotenv.config();
const client = new DBSQLClient();
const host = process.env.DATABRICKS_HOST_USCA;
const path = process.env.DATABRICKS_PATH_USCA;
const token = process.env.DATABRICKS_TOKEN_USCA;
console.log('Connecting to US/CA host:', host);
console.log('Using path:', path);
console.log('Token loaded:', !!token, 'length:', token ? token.length : 0);
await client.connect({
  host,
  path,
  token,
  telemetryEnabled: false,
});
const session = await client.openSession();
try {
  const op = await session.executeStatement('SELECT 1 AS test_value');
  const rows = await op.fetchAll();
  await op.close();
  console.log('Query result:', JSON.stringify(rows, null, 2));
} finally {
  await session.close();
  await client.close();
}
