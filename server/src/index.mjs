import { createApp } from './app.mjs';
const app = await createApp({ databasePath: process.env.DATABASE_PATH ?? './data/accounts.sqlite',
  ...(process.env.TRUST_PROXY ? {trustedProxy:process.env.TRUST_PROXY.split(',').map(s=>s.trim())} : {}) });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
console.log(`Account server listening on ${app.server.address().address}:${app.server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
