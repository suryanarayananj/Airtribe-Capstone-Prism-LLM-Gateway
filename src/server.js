import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { initDb, listSeededVirtualKeys } from './db.js';
import { prismErrorHandler } from './errors.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAppChatRoutes } from './routes/appChat.js';

async function main() {
  initDb();

  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
  });

  app.setErrorHandler(prismErrorHandler);

  app.get('/health', async () => ({
    status: 'ok',
    upstream: config.upstreamMode,
    aliases: Object.keys(config.modelAliases),
  }));

  await registerChatRoutes(app);
  await registerAdminRoutes(app);
  await registerAppChatRoutes(app);

  await app.listen({ port: config.port, host: config.host });

  const keys = listSeededVirtualKeys();
  app.log.info(
    {
      port: config.port,
      dbPath: config.dbPath,
      upstream: config.upstreamMode,
      seededKeys: keys.length,
      aliases: Object.keys(config.modelAliases),
    },
    'Prism gateway listening',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
