import { envInt } from '@anchorpay/service-kit';
import { buildMockProviders } from './app.ts';

const { service, partner } = buildMockProviders();
await service.app.listen({ port: envInt('MOCK_PROVIDERS_PORT', 4900), host: '127.0.0.1' });
partner.resume();
service.log.warn('mock providers running: card processor, bank debit and payout partner (TEST MODE, no real money)');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  service.log.info({ signal }, 'shutting down');
  partner.stop();
  await service.app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
