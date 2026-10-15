import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';

export async function registerHealthRoutes(app: FastifyInstance, db: Db) {
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_request, reply) => {
    try {
      const database = await withTimeout(db.health(), 5_000);
      return { ok: database, database };
    } catch {
      return reply.code(503).send({ ok: false, database: false });
    }
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
