import { createKafka, envInt, OutboxRelay } from '@anchorpay/service-kit';
import { buildTransferService, defaultInfrastructure, RecoveryJob, startTransferConsumer } from './app.ts';
import { SERVICE } from './domain/transfers.ts';

const infra = defaultInfrastructure();
const { service, workflow } = buildTransferService(infra);
const kafka = createKafka(SERVICE);
const relay = new OutboxRelay({ pool: infra.pool, schema: 'core', kafka, log: infra.log });
const recovery = new RecoveryJob(workflow, infra.log);

await service.app.listen({ port: envInt('TRANSFER_SERVICE_PORT', 4002), host: '127.0.0.1' });
relay.start();
const consumer = await startTransferConsumer(kafka, infra, workflow);
recovery.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  infra.log.info({ signal }, 'shutting down');
  await service.app.close();
  await recovery.stop();
  await consumer.stop();
  await relay.stop();
  await infra.pool.end();
  infra.redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
