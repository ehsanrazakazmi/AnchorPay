import { createKafka, envInt, OutboxRelay } from '@anchorpay/service-kit';
import { backgroundJobs, buildPaymentService, defaultInfrastructure } from './app.ts';
import { SERVICE } from './deps.ts';

const infra = defaultInfrastructure();
const { service, payments, payouts } = buildPaymentService(infra);
const relay = new OutboxRelay({ pool: infra.pool, schema: 'payments', kafka: createKafka(SERVICE), log: infra.log });
const jobs = backgroundJobs(payments, payouts, infra.log);

await service.app.listen({ port: envInt('PAYMENT_SERVICE_PORT', 4003), host: '127.0.0.1' });
relay.start();
for (const job of jobs) job.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  infra.log.info({ signal }, 'shutting down');
  await service.app.close();
  for (const job of jobs) await job.stop();
  await relay.stop();
  await infra.pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
