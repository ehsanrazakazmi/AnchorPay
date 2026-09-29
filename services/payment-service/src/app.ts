import { createLogger, createPool, createService, type Logger, type Pool, type Service } from '@anchorpay/service-kit';
import { SERVICE } from './deps.ts';
import { Payments } from './domain/payments.ts';
import { httpRecipients, Payouts, type RecipientDirectory } from './domain/payouts.ts';
import { partnerFromEnv, type PayoutPartner } from './partner.ts';
import { providersFromEnv, type Providers } from './providers.ts';
import { registerRoutes } from './routes.ts';
import { Webhooks } from './webhooks.ts';

export interface Infrastructure {
  pool: Pool;
  log: Logger;
  providers?: Providers;
  partner?: PayoutPartner;
  recipients?: RecipientDirectory;
  payoutBackoffSeconds?: number[];
}

export function defaultInfrastructure(): Infrastructure {
  return { pool: createPool('payments', SERVICE), log: createLogger(SERVICE) };
}

export function buildPaymentService(infra: Infrastructure): { service: Service; payments: Payments; payouts: Payouts } {
  const payments = new Payments({ pool: infra.pool, providers: infra.providers ?? providersFromEnv(), log: infra.log });
  const payouts = new Payouts({
    pool: infra.pool, partner: infra.partner ?? partnerFromEnv(), recipients: infra.recipients ?? httpRecipients(), log: infra.log,
    ...(infra.payoutBackoffSeconds ? { backoffSeconds: infra.payoutBackoffSeconds } : {}),
  });
  const webhooks = new Webhooks({ pool: infra.pool, payments, payouts, log: infra.log });
  const service = createService({ name: SERVICE, logger: infra.log, rawBody: true, health: { postgres: () => infra.pool.query('SELECT 1') } });
  registerRoutes(service, { payments, payouts, webhooks, log: infra.log });

  const missing = service.unhandled();
  if (missing.length) throw new Error(`${SERVICE} does not implement contract operations: ${missing.join(', ')}`);
  return { service, payments, payouts };
}

/** Runs `task` every `intervalMs`, never two at once (a slow pass just delays the next one). */
export class Repeater {
  private readonly name: string;
  private readonly task: () => Promise<unknown>;
  private readonly intervalMs: number;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(name: string, task: () => Promise<unknown>, intervalMs: number, log: Logger) {
    this.name = name;
    this.task = task;
    this.intervalMs = intervalMs;
    this.log = log;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.task()
        .then(() => undefined)
        .catch((err) => this.log.error({ err, job: this.name }, 'background job failed'))
        .finally(() => {
          this.running = undefined;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}

/** Payout dispatcher (every second) and maintenance: lapsed holds + unsent refunds (every 30 s). */
export function backgroundJobs(payments: Payments, payouts: Payouts, log: Logger): Repeater[] {
  return [
    new Repeater('payout-dispatch', () => payouts.dispatchDue(), 1000, log),
    new Repeater('payment-maintenance', () => payments.maintain(), 30_000, log),
  ];
}
