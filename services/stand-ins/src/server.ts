// Starts the TEMPORARY compliance stand-in (DECISIONS D-39). It steps aside as soon as the real service exists
// (services/compliance-service/src/server.ts), so nothing needs deleting when Step 6 lands.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKafka, createLogger, envInt, REPO_ROOT, type Service } from '@anchorpay/service-kit';
import { buildComplianceStandIn, type Publish } from './stand-ins.ts';

const log = createLogger('stand-ins');
const realServiceExists = (name: string) => existsSync(join(REPO_ROOT, 'services', name, 'src', 'server.ts'));

const producer = createKafka('stand-ins').producer({ kafkaJS: { idempotent: true, acks: -1 } });
await producer.connect();
const publish: Publish = async (event, key) => {
  await producer.send({ topic: event.eventType, messages: [{ key, value: JSON.stringify(event) }] });
};

const running: Service[] = [];
async function start(name: string, port: number, build: () => Service) {
  if (realServiceExists(name)) {
    log.info(`${name} exists now; its stand-in stays off`);
    return;
  }
  const svc = build();
  await svc.app.listen({ port, host: '127.0.0.1' });
  running.push(svc);
  log.warn(`TEMPORARY ${name} stand-in on port ${port} (in-memory, scripted outcomes)`);
}

await start('compliance-service', envInt('COMPLIANCE_SERVICE_PORT', 5001), () => buildComplianceStandIn({ publish, log }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  await Promise.all(running.map((s) => s.app.close()));
  await producer.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
