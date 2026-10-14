import { config as loadDotenv } from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';

loadDotenv({ path: ['.env.local', '.env'], quiet: true });

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
const pool = new Pool({ connectionString: url, max: 1 });
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../migrations');

try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const existing = await pool.query('SELECT name FROM schema_migrations WHERE name=$1 LIMIT 1', [file]);
    if (existing.rowCount) continue;
    const text = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(text);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
