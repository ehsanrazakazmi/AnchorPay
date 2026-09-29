import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDestination, HttpCorridorCatalog } from '../src/domain/corridors.ts';
import { buildTestService, expectContract, signUp, TEST_DESTINATIONS, type TestService } from './helpers.ts';

let fx: FastifyInstance;
let fxUrl = '';
let calls = 0;
let up = true;
const seen: Record<string, string | undefined>[] = [];

beforeAll(async () => {
  // A stand-in for fx-service's /internal/fx/corridors.
  fx = Fastify();
  fx.get('/internal/fx/corridors', async (req, reply) => {
    calls += 1;
    seen.push({ caller: req.headers['x-calling-service'] as string, token: req.headers['x-internal-token'] as string });
    if (!up) return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' });
    return { data: [{ code: 'CA-PK', receiveCountry: 'PK', receiveCurrency: 'PKR', payoutMethods: ['bank_account'], enabled: true }] };
  });
  await fx.listen({ port: 0, host: '127.0.0.1' });
  fxUrl = `http://127.0.0.1:${(fx.server.address() as AddressInfo).port}`;
});
afterAll(() => fx.close());

describe('HttpCorridorCatalog', () => {
  it('reads fx-service as identity-service and caches the list', async () => {
    calls = 0;
    up = true;
    const catalog = new HttpCorridorCatalog({ baseUrl: fxUrl, ttlMs: 60_000 });
    const first = await catalog.destinations('req_1');
    await catalog.destinations('req_2');
    expect(first).toEqual([{ country: 'PK', currency: 'PKR', payoutMethods: ['bank_account'], enabled: true }]);
    expect(calls).toBe(1);
    expect(seen.at(-1)).toEqual({ caller: 'identity-service', token: process.env.INTERNAL_SERVICE_TOKEN });
  });

  it('keeps serving the last good list when fx-service goes down', async () => {
    up = true;
    const catalog = new HttpCorridorCatalog({ baseUrl: fxUrl, ttlMs: 0 });
    await catalog.destinations('req_1');
    up = false;
    expect((await catalog.destinations('req_2'))[0]?.country).toBe('PK');
  });

  it('refuses when it has never seen a list', async () => {
    up = false;
    const catalog = new HttpCorridorCatalog({ baseUrl: fxUrl });
    await expect(catalog.destinations('req_1')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const unreachable = new HttpCorridorCatalog({ baseUrl: 'http://127.0.0.1:1' });
    await expect(unreachable.destinations('req_1')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('recipient destinations', () => {
  let t: TestService;
  beforeAll(() => {
    t = buildTestService();
  });
  afterAll(() => t.close());

  it('checks country, currency, enabled flag and payout method', async () => {
    const list = await TEST_DESTINATIONS.destinations();
    expect(() => assertDestination(list, 'PK', 'PKR', 'mobile_wallet')).not.toThrow();
    const cases: [string, string, string, RegExp][] = [
      ['US', 'USD', 'bank_account', /not available/],
      ['PK', 'INR', 'bank_account', /paid in PKR/],
      ['BD', 'BDT', 'bank_account', /temporarily unavailable/],
      ['IN', 'INR', 'mobile_wallet', /mobile wallet payouts are not available/],
    ];
    for (const [country, currency, method, message] of cases) {
      expect(() => assertDestination(list, country, currency, method)).toThrow(message);
    }
  });

  it('a disabled corridor stops accepting new recipients', async () => {
    const { headers } = await signUp(t);
    const res = await t.app.inject({
      method: 'POST', url: '/v1/recipients', headers,
      payload: { fullName: 'Rahim Uddin', country: 'BD', currency: 'BDT', payoutMethod: 'bank_account', bankAccount: { bankName: 'X', accountNumber: '1234567890' } },
    });
    expect(expectContract('createRecipient', res, 422)).toMatchObject({ code: 'CORRIDOR_UNAVAILABLE', detail: expect.stringMatching(/temporarily/) });
  });
});
