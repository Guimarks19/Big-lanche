const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const { loadEnv } = require('../config/env');

function createDatabase(filePath, options = {}) {
  const env = loadEnv(options.env || {});
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;

  if (databaseUrl && !String(databaseUrl).startsWith('sqlite:')) {
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });

    return {
      dialect: 'postgres',
      async exec(sql) {
        for (const statement of splitStatements(sql)) {
          await pool.query(statement);
        }
      },
      async close() {
        await pool.end();
      },
      async query(sql, params = []) {
        return pool.query(toPostgresPlaceholders(sql), params);
      },
      pool,
    };
  }

  const databasePath = filePath || env.DATABASE_PATH;

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA journal_mode = WAL;');

  return {
    dialect: 'sqlite',
    exec(sql) {
      return sqlite.exec(sql);
    },
    prepare(sql) {
      return sqlite.prepare(sql);
    },
    close() {
      return sqlite.close();
    },
    raw: sqlite,
  };
}

async function run(db, sql, params = []) {
  if (db.dialect === 'postgres') {
    const result = await db.query(sql, params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id,
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  return db.prepare(sql).run(...params);
}

async function insert(db, sql, params = []) {
  const finalSql =
    db.dialect === 'postgres' && !/\breturning\b/i.test(sql) ? `${sql} RETURNING id` : sql;
  const result = await run(db, finalSql, params);
  return result.lastInsertRowid;
}

async function get(db, sql, params = []) {
  if (db.dialect === 'postgres') {
    const result = await db.query(sql, params);
    return result.rows[0] || null;
  }

  return db.prepare(sql).get(...params);
}

async function all(db, sql, params = []) {
  if (db.dialect === 'postgres') {
    const result = await db.query(sql, params);
    return result.rows;
  }

  return db.prepare(sql).all(...params);
}

async function withTransaction(db, callback) {
  if (db.dialect === 'postgres') {
    const client = await db.pool.connect();
    const txDb = {
      ...db,
      async query(sql, params = []) {
        return client.query(toPostgresPlaceholders(sql), params);
      },
    };

    try {
      await client.query('BEGIN');
      const result = await callback(txDb);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = await callback(db);
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function toPostgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

module.exports = {
  all,
  createDatabase,
  get,
  insert,
  run,
  withTransaction,
};
