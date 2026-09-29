import { randomInt, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import {
  createLogger, createPool, createRedis, PiiCipher, type EmailMessage, type Messenger, type SmsMessage,
} from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { buildIdentityService } from '../src/app.ts';
import { StaticCorridorCatalog } from '../src/domain/corridors.ts';

/** Mirrors the seeded fx.corridors (tests don't need fx-service running). */
export const TEST_DESTINATIONS = new StaticCorridorCatalog([
  { country: 'PK', currency: 'PKR', payoutMethods: ['bank_account', 'mobile_wallet'], enabled: true },
  { country: 'IN', currency: 'INR', payoutMethods: ['bank_account'], enabled: true },
  { country: 'BD', currency: 'BDT', payoutMethods: ['bank_account'], enabled: false },
]);

/** Captures outgoing messages so tests can read verification codes and links. */
export class MemoryMessenger implements Messenger {
  readonly emails: EmailMessage[] = [];
  readonly sms: SmsMessage[] = [];
  async sendEmail(m: EmailMessage) {
    this.emails.push(m);
  }
  async sendSms(m: SmsMessage) {
    this.sms.push(m);
  }
  lastEmail(to: string, template: string) {
    return [...this.emails].reverse().find((m) => m.to === to && m.template === template);
  }
  lastToken(to: string, template: string): string {
    const token = this.lastEmail(to, template)?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error(`no ${template} email for ${to}`);
    return token;
  }
  lastCode(to: string): string {
    const code = [...this.sms].reverse().find((m) => m.to === to)?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no SMS code for ${to}`);
    return code;
  }
}

export function buildTestService(options: { cipher?: PiiCipher } = {}) {
  const messenger = new MemoryMessenger();
  const infra = {
    pool: createPool('core', 'identity-test'),
    redis: createRedis(),
    messenger,
    cipher: options.cipher ?? PiiCipher.fromEnv(),
    log: createLogger('identity-test'),
    corridors: TEST_DESTINATIONS,
  };
  const { service, deps } = buildIdentityService(infra);
  const reporting = createPool('reporting', 'identity-test');
  return {
    app: service.app,
    deps,
    messenger,
    reporting,
    async close() {
      await service.app.close();
      await infra.pool.end();
      await reporting.end();
      infra.redis.disconnect();
    },
  };
}

export type TestService = ReturnType<typeof buildTestService>;

export const TOKEN = () => process.env.INTERNAL_SERVICE_TOKEN!;
export const viaGateway = () => ({ 'x-internal-token': TOKEN() });
export const asUser = (userId: string, role = 'customer', sessionId = 'test-session') => ({
  ...viaGateway(), 'x-user-id': userId, 'x-user-role': role, 'x-session-id': sessionId,
});
export const asService = (caller: string) => ({ 'x-internal-token': TOKEN(), 'x-calling-service': caller });

export const uniqueEmail = () => `user.${randomUUID().slice(0, 8)}@example.com`;
export const uniquePhone = () => `+1416${String(randomInt(1_000_000, 9_999_999))}`;
export const STRONG_PASSWORD = 'Correct-Horse-Battery-9';

export function registration(overrides: Record<string, unknown> = {}) {
  return {
    email: uniqueEmail(),
    phone: uniquePhone(),
    password: STRONG_PASSWORD,
    fullName: 'Ayesha Khan',
    dateOfBirth: '1995-04-12',
    address: { line1: '100 Queen St W', city: 'Toronto', province: 'ON', postalCode: 'M5H 2N2' },
    country: 'CA',
    acceptTerms: true,
    ...overrides,
  };
}

/** Asserts the status and that the body matches the contract for that operation + status. */
export function expectContract(operationId: string, res: LightMyRequestResponse, status: number): any {
  if (res.statusCode !== status) throw new Error(`${operationId}: expected ${status}, got ${res.statusCode}: ${res.body}`);
  const body = res.body ? res.json() : undefined;
  assertMatchesContract(operationId, status, body);
  return body;
}

/** Registers a user and logs in; returns ids, tokens and the registration payload. */
export async function signUp(t: TestService, overrides: Record<string, unknown> = {}) {
  const reg = registration(overrides);
  const created = expectContract('registerUser', await t.app.inject({ method: 'POST', url: '/v1/users', headers: viaGateway(), payload: reg }), 201);
  const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: viaGateway(), payload: { email: reg.email, password: reg.password } });
  const tokens = expectContract('login', login, 200);
  return { reg, user: created, tokens, headers: asUser(created.id) };
}
