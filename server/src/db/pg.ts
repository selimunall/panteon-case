import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createPg(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createPg>['db'];
export { schema };
