import { createApp } from './app.mjs';
const app = await createApp({ databasePath: process.env.DATABASE_PATH ?? './data/accounts.sqlite',
  modelKey: process.env.SHARED_MODEL_KEY ?? '', modelKeyFile: process.env.MODEL_KEY_FILE ?? './data/shared-model-key',
  deliveryEnabled: process.env.WORKFLOW_DELIVERY_ENABLED === 'true', allowLocalCredentials: process.env.ALLOW_LOCAL_CREDENTIALS === 'true',
  ...(process.env.TRUST_PROXY ? {trustedProxy:process.env.TRUST_PROXY.split(',').map(s=>s.trim())} : {}) });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
console.log(`Account server listening on ${app.server.address().address}:${app.server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
