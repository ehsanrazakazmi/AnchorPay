import { createLogger, createRedis, envInt } from '@anchorpay/service-kit';
import { buildGateway } from './app.ts';

const log = createLogger('gateway');
const redis = createRedis();
const app = await buildGateway({ redis, log });
await app.listen({ port: envInt('GATEWAY_PORT', 8080), host: '127.0.0.1' });

async function shutdown() {
  await app.close();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
