import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';

export async function registerHealthRoutes(app: FastifyInstance, db: Db) {
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_request, reply) => {
    try {
      const database = await db.health();
      return { ok: database, database };
    } catch {
      return reply.code(503).send({ ok: false, database: false });
    }
  });
}
