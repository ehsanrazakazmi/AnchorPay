// npm run infra:start | infra:stop | infra:status
// Wraps the portable Kafka + Garnet install in DEVTOOLS_DIR (docs/local-setup.md).
// PostgreSQL runs as a Windows service and is not started/stopped here.
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { env } from './lib/env.mjs';

const SERVICES = [
  { name: 'PostgreSQL', host: env('PGHOST', '127.0.0.1'), port: Number(env('PGPORT', '5433')) },
  { name: 'Garnet (Redis)', host: '127.0.0.1', port: Number(new URL(env('REDIS_URL')).port || 6379) },
  { name: 'Kafka', host: '127.0.0.1', port: Number(env('KAFKA_BROKERS').split(',')[0].split(':')[1]) },
];

const isListening = ({ host, port }) =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });

async function status() {
  for (const s of SERVICES) console.log(`${(await isListening(s)) ? 'UP  ' : 'DOWN'}  ${s.name.padEnd(15)} ${s.host}:${s.port}`);
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const command = process.argv[2];
const devtools = env('DEVTOOLS_DIR');

if (command === 'start') {
  // stdio must not be inherited: the long-running Kafka/Garnet windows would inherit this process's
  // stdout and keep a caller's pipe open forever (e.g. `npm run infra:start | tail`).
  spawnSync('cmd.exe', ['/c', join(devtools, 'start-infra.cmd')], { stdio: 'ignore' });
  console.log('Starting Garnet and Kafka (up to 60 s)...');
  const [, garnet, kafka] = SERVICES;
  const ok = await waitFor(async () => (await isListening(garnet)) && (await isListening(kafka)), 60_000);
  await status();
  if (!ok) process.exit(1);
} else if (command === 'stop') {
  spawnSync('cmd.exe', ['/c', join(devtools, 'stop-infra.cmd')], { stdio: 'inherit' });
} else if (command === 'status') {
  await status();
} else {
  console.error('Usage: node scripts/infra.mjs start | stop | status');
  process.exit(1);
}
