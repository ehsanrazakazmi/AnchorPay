import { createKafka, envInt, OutboxRelay } from '@anchorpay/service-kit';
import { buildIdentityService, defaultInfrastructure } from './app.ts';
import { SERVICE } from './deps.ts';

const infra = defaultInfrastructure();
const { service } = buildIdentityService(infra);
const relay = new OutboxRelay({ pool: infra.pool, schema: 'core', kafka: createKafka(SERVICE), log: infra.log });

await service.app.listen({ port: envInt('IDENTITY_SERVICE_PORT', 4001), host: '127.0.0.1' });
relay.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  infra.log.info({ signal }, 'shutting down');
  await service.app.close();
  await relay.stop();
  await infra.pool.end();
  infra.redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
