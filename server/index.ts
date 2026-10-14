import { createApp } from './app.js';
import { config } from './config.js';

const { app } = await createApp();
try { await app.listen({ host: config.host, port: config.port }); console.log(`Encore API listening on ${config.appUrl}`); }
catch { console.error('Encore could not start. Check PORT, DATA_DIR, and the encryption-key configuration.'); process.exitCode = 1; await app.close(); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
