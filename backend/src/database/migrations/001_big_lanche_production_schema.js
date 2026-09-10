const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '001_big_lanche_production_schema',

  async up(db) {
    const schemaFile = db.dialect === 'postgres' ? 'schema.postgres.sql' : 'schema.sql';
    const schemaPath = path.join(__dirname, '..', schemaFile);
    await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  },
};
