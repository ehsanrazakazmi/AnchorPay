import {
  createLogger, createPool, createRedis, createService, startConsumer, type Kafka, type Logger, type Pool, type Redis,
  type RunningConsumer, type Service,
} from '@anchorpay/service-kit';
import { SERVICE } from './domain/transfers.ts';
import { Workflow } from './domain/workflow.ts';
import { HttpPorts, type Ports } from './ports.ts';
import { registerRoutes } from './routes.ts';

/** Events that move a transfer forward (contracts/events/topics.yaml: consumers include transfer-service). */
export const TOPICS = [
  'payment.authorized', 'payment.failed', 'payment.refunded', 'payout.dispatched', 'payout.completed', 'payout.failed',
  'compliance.review-decided', 'fx.lock-expired',
];

export interface Infrastructure {
  pool: Pool;
  redis: Redis;
  log: Logger;
  ports?: Ports;
}

export function defaultInfrastructure(): Infrastructure {
  return { pool: createPool('core', SERVICE), redis: createRedis(), log: createLogger(SERVICE) };
}

export function buildTransferService(infra: Infrastructure): { service: Service; workflow: Workflow } {
  const workflow = new Workflow({ pool: infra.pool, redis: infra.redis, log: infra.log, ports: infra.ports ?? new HttpPorts() });
  const service = createService({
    name: SERVICE,
    logger: infra.log,
    health: { postgres: () => infra.pool.query('SELECT 1'), redis: () => infra.redis.ping() },
  });
  registerRoutes(service, infra.pool, workflow);

  const missing = service.unhandled();
  if (missing.length) throw new Error(`${SERVICE} does not implement contract operations: ${missing.join(', ')}`);
  return { service, workflow };
}

export function startTransferConsumer(
  kafka: Kafka, infra: Infrastructure, workflow: Workflow, options: { groupId?: string; fromBeginning?: boolean } = {},
): Promise<RunningConsumer> {
  return startConsumer({
    kafka, service: SERVICE, topics: TOPICS, pool: infra.pool, schema: 'core', log: infra.log, ...options,
    handler: (event, client) => workflow.onEvent(event, client),
  });
}

/** Every 30 s, resumes transfers stuck for over a minute (a crash, a missed event, a dependency outage). */
export class RecoveryJob {
  private readonly workflow: Workflow;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(workflow: Workflow, log: Logger, intervalMs = 30_000) {
    this.workflow = workflow;
    this.log = log;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.running) return; // the previous pass is still working
      this.running = this.workflow.recover()
        .then((n) => {
          if (n) this.log.info({ transfers: n }, 'recovery pass resumed stale transfers');
        })
        .catch((err) => this.log.error({ err }, 'recovery pass failed'))
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
