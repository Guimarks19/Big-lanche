const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('./connection');

function migrate(db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

if (require.main === module) {
  const db = createDatabase();
  migrate(db);
  db.close();
  console.log('Banco SQLite migrado com sucesso.');
}

module.exports = { migrate };
