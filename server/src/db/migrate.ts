import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') });
  await pool.end();
}

// Allow `pnpm db:migrate` as a standalone script.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard';
  runMigrations(url).then(() => { console.log('migrated'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
