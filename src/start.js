'use strict';

const { buildServer } = require('./server');
const { createDatabase, resolveDatabaseFile } = require('./db/database');

const port = Number(process.env.PORT) || 3000;
const databaseFile =
  process.env.DATABASE_FILE || resolveDatabaseFile(process.cwd());

async function main() {
  const db = createDatabase({ filename: databaseFile });
  const app = await buildServer({ db });
  await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
  console.log(`Kinesis ready at ${app.server.address().address}:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
