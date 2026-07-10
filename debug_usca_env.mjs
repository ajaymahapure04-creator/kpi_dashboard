import dotenv from 'dotenv';
dotenv.config();

const env = {
  DATABRICKS_HOST_USCA: process.env.DATABRICKS_HOST_USCA,
  DATABRICKS_PATH_USCA: process.env.DATABRICKS_PATH_USCA,
  DATABRICKS_TOKEN_USCA_LOADED: !!process.env.DATABRICKS_TOKEN_USCA,
  DATABRICKS_TOKEN_USCA_LENGTH: process.env.DATABRICKS_TOKEN_USCA ? process.env.DATABRICKS_TOKEN_USCA.length : 0,
  DATALAKE_PROD_SCHEMA: process.env.DATALAKE_PROD_SCHEMA,
  DATALAKE_INT_SCHEMA: process.env.DATALAKE_INT_SCHEMA,
  DATALAKE_DEV_SCHEMA: process.env.DATALAKE_DEV_SCHEMA,
};

console.log('US/CA Databricks env values:');
console.log(JSON.stringify(env, null, 2));
