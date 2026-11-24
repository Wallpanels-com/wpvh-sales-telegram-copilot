import { Pool } from 'pg';

export function postgresPool(connectionString: string, max: number) {
  const ca = process.env.DATABASE_CA_CERT;
  return new Pool({
    connectionString, max, connectionTimeoutMillis: 10000, allowExitOnIdle: true,
    ssl: ca ? { ca, rejectUnauthorized: true } : undefined,
    onConnect: ca ? async (client) => {
      const { rows } = await client.query('SELECT current_schema() AS schema');
      if (rows[0]?.schema !== 'copilot') throw new Error('Expected the private Copilot schema');
    } : undefined
  });
}
