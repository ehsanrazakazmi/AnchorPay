// mock-providers (port 4900): free, local stand-ins for the external companies AnchorPay would contract with.
// Not part of our API contract: it plays the *other side* of the provider adapters in payment-service.
import { join } from 'node:path';
import { AppError, createLogger, createService, env, REPO_ROOT, safeEqual, serviceUrl, type Logger, type Service } from '@anchorpay/service-kit';
import { Partner, registerPartnerRoutes } from './partner.ts';
import { registerPaymentRoutes } from './payments.ts';
import { Store } from './store.ts';
import { httpDeliverer, type Deliver } from './webhooks.ts';

export interface MockOptions {
  log?: Logger;
  /** null = memory only (tests). Default: var/mock-providers. */
  dataDir?: string | null;
  deliver?: Deliver;
  payoutDelayMs?: number;
  /** Base URL customers' browsers use for the card form. */
  publicUrl?: string;
}

export function buildMockProviders(options: MockOptions = {}): { service: Service; store: Store; partner: Partner } {
  const log = options.log ?? createLogger('mock-providers');
  const dataDir = options.dataDir === undefined ? join(REPO_ROOT, env('MOCK_PROVIDERS_DATA_DIR', 'var/mock-providers')) : options.dataDir;
  const secret = env('MOCK_WEBHOOK_SECRET');
  const service = createService({ name: 'mock-providers', logger: log });
  service.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  const store = new Store(dataDir);
  const deliver = options.deliver ?? httpDeliverer({ baseUrl: env('MOCK_WEBHOOK_TARGET_URL', serviceUrl('gateway')), secret, log });
  const partner = new Partner({ store, deliver, log, dataDir, ...(options.payoutDelayMs !== undefined ? { delayMs: options.payoutDelayMs } : {}) });

  // AnchorPay authenticates to the providers with the shared mock secret (a real provider issues an API key).
  const requireApiKey = (headers: unknown) => {
    const auth = (headers as Record<string, string | undefined>).authorization ?? '';
    if (!safeEqual(auth, `Bearer ${secret}`)) throw new AppError('UNAUTHENTICATED', 'Missing or invalid provider API key.');
  };
  const publicUrl = options.publicUrl ?? env('MOCK_PROVIDERS_URL', 'http://127.0.0.1:4900');
  registerPaymentRoutes(service, { store, deliver, publicUrl, requireApiKey });
  registerPartnerRoutes(service, partner, requireApiKey, store);
  return { service, store, partner };
}
