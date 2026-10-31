require('dotenv').config();

// Local Garmin pilot settings are read from the private operator config when
// present. This is opt-in and does not start the connector or contact Garmin.
require('../scripts/garmin-local-config').applyRuntimeConfig({
  explicitEnv: process.env,
  variables: [
    'GARMIN_PILOT_USER_ID', 'KINESIS_GARMIN_SERVICE_TOKEN',
    'GARMIN_CONNECTOR_PORT', 'GARMIN_CONNECTOR_URL', 'GARMIN_PILOT_ENABLED', 'GARMIN_STORE',
  ],
});

'use strict';

const { readAiConfig, aiStartupStatus } = require('./ai/config');
const { buildServer } = require('./server');
const { createDatabase, resolveDatabaseFile } = require('./db/database');

const port = Number(process.env.PORT) || 3000;
const databaseFile =
  process.env.DATABASE_FILE || resolveDatabaseFile(process.cwd());

console.log(
  '[Kinesis] Unsplash API Key configured:',
  Boolean(process.env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_API_KEY),
);

const aiConfig = readAiConfig();
console.log('[Kinesis] OpenAI:', aiStartupStatus(aiConfig));

async function main() {
  const db = createDatabase({ filename: databaseFile });
  const app = await buildServer({ db, aiConfig });
  await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
  console.log(`Kinesis ready at ${app.server.address().address}:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
