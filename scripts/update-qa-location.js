'use strict';

const { join } = require('node:path');
const { createDatabase } = require('../src/db/database');

const DB_FILE = join(__dirname, '..', 'data', 'database.sqlite');
const DIA = '2026-09-06';
const LOCATION = 'Fanzeres, Portugal';

const db = createDatabase({ filename: DB_FILE });

const find = db.prepare('SELECT id FROM trainings WHERE dia = ?');
const update = db.prepare('UPDATE trainings SET location = ? WHERE dia = ?');

const result = find.all(DIA);
console.log(`Found ${result.length} training row(s) on ${DIA}.`);

const info = update.run(LOCATION, DIA);
console.log(`Updated ${info.changes} row(s) with location "${LOCATION}".`);

const verify = db
  .prepare('SELECT id, dia, treino, location FROM trainings WHERE dia = ?')
  .all(DIA);
console.log(JSON.stringify(verify, null, 2));

db.close();