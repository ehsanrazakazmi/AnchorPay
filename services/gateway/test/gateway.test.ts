import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { importPKCS8, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, createRedis, REPO_ROOT, sessionKeys, SERVICE_PORT_VARS } from '@anchorpay/service-kit';
import { buildGateway } from '../src/app.ts';
import { buildRouteTable, matchRoute } from '../src/routes.ts';

const USER = '0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b';
const redis = createRedis();
let stub: FastifyInstance;
let gw: FastifyInstance;
let strict: FastifyInstance;

async function token(claims: { role?: string; sid?: string; sub?: string; exp?: string; aud?: string } = {}) {
  const key = await importPKCS8(readFileSync(join(REPO_ROOT, process.env.JWT_PRIVATE_KEY_PATH!), 'utf8'), 'RS256');
  return new SignJWT({ role: claims.role ?? 'customer', sid: claims.sid ?? 'sid-1' })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(claims.sub ?? USER)
    .setIssuer(process.env.JWT_ISSUER!)
    .setAudience(claims.aud ?? process.env.JWT_AUDIENCE!)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '15m')
    .sign(key);
}
const bearer = async (claims?: Parameters<typeof token>[0]) => ({ authorization: `Bearer ${await token(claims)}` });

beforeAll(async () => {
  // A stand-in for every service: echoes what it received.
  stub = Fastify();
  stub.removeAllContentTypeParsers();
  stub.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  stub.get('/health', async () => ({ status: 'ok' }));
  stub.all('/*', async (req) => ({ method: req.method, url: req.url, headers: req.headers, body: req.body ? String(req.body) : null }));
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const stubUrl = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  const upstreams = Object.fromEntries(Object.keys(SERVICE_PORT_VARS).map((s) => [s, stubUrl]));
  upstreams['ledger-service'] = 'http://127.0.0.1:1'; // a service that is down

  const log = createLogger('gateway-test');
  gw = await buildGateway({ redis, log, upstreams, rateLimits: { defaultPerMinute: 1000, sensitivePerMinute: 1000 }, maxBodyBytes: 1024 });
  strict = await buildGateway({ redis, log, upstreams, rateLimits: { defaultPerMinute: 1000, sensitivePerMinute: 3 } });
});
afterAll(async () => {
  await gw.close();
  await strict.close();
  await stub.close();
  redis.disconnect();
});

describe('route table', () => {
  it('prefers literal paths over parameters and never exposes /internal', () => {
    const routes = buildRouteTable();
    expect(matchRoute(routes, 'GET', '/v1/admin/reports/daily-summary')?.op.operationId).toBe('getDailyRegulatorySummary');
    expect(matchRoute(routes, 'GET', `/v1/admin/reports/${USER}`)?.op.operationId).toBe('getRegulatoryReport');
    expect(matchRoute(routes, 'GET', '/internal/identity/users/x')).toBeUndefined();
    expect(matchRoute(routes, 'DELETE', '/v1/users/me')).toBeUndefined();
  });
});

describe('forwarding', () => {
  it('forwards public routes with the gateway token, request id and no client-supplied identity', async () => {
    const res = await gw.inject({
      method: 'POST', url: '/v1/auth/login?x=1',
      headers: { 'content-type': 'application/json', 'x-user-id': USER, 'x-user-role': 'admin', 'x-internal-token': 'forged', 'x-request-id': 'req_abc' },
      payload: { email: 'a@b.com', password: 'x' },
    });
    expect(res.statusCode).toBe(200);
    const echo = res.json();
    expect(echo.url).toBe('/v1/auth/login?x=1');
    expect(echo.headers['x-internal-token']).toBe(process.env.INTERNAL_SERVICE_TOKEN);
    expect(echo.headers['x-user-id']).toBeUndefined();
    expect(echo.headers['x-user-role']).toBeUndefined();
    expect(echo.headers['x-request-id']).toBe('req_abc');
    expect(JSON.parse(echo.body)).toEqual({ email: 'a@b.com', password: 'x' });
    expect(res.headers['x-request-id']).toBe('req_abc');
  });

  it('adds identity headers for a valid token and strips the raw token', async () => {
    const res = await gw.inject({ method: 'GET', url: '/v1/users/me', headers: await bearer({ sid: 'sid-ok' }) });
    const echo = res.json();
    expect(echo.headers).toMatchObject({ 'x-user-id': USER, 'x-user-role': 'customer', 'x-session-id': 'sid-ok' });
    expect(echo.headers.authorization).toBeUndefined();
  });

  it('streams webhook bodies byte-for-byte without a JWT', async () => {
    const raw = '{"eventId":"e1","type":"payout.completed",  "spacing":"kept"}';
    const res = await gw.inject({ method: 'POST', url: '/webhooks/payout-partner', headers: { 'content-type': 'application/json', 'x-signature': 'abc' }, payload: raw });
    expect(res.json().body).toBe(raw);
  });

  it('optional auth: anonymous quotes pass through; a bad token is still rejected', async () => {
    const anon = await gw.inject({ method: 'POST', url: '/v1/quotes', headers: { 'content-type': 'application/json' }, payload: {} });
    expect(anon.json().headers['x-user-id']).toBeUndefined();
    const withUser = await gw.inject({ method: 'POST', url: '/v1/quotes', headers: { ...(await bearer()), 'content-type': 'application/json' }, payload: {} });
    expect(withUser.json().headers['x-user-id']).toBe(USER);
    const bad = await gw.inject({ method: 'POST', url: '/v1/quotes', headers: { authorization: 'Bearer a.b.c' }, payload: {} });
    expect(bad.statusCode).toBe(401);
  });
});

describe('authentication and roles', () => {
  it('requires a token on protected routes', async () => {
    const res = await gw.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('rejects expired, wrong-audience and tampered tokens', async () => {
    const expired = await gw.inject({ method: 'GET', url: '/v1/users/me', headers: await bearer({ exp: '-1m' }) });
    expect(expired.json().detail).toMatch(/expired/);
    expect((await gw.inject({ method: 'GET', url: '/v1/users/me', headers: await bearer({ aud: 'someone-else' }) })).statusCode).toBe(401);
    const good = await token();
    const [h, p, s] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'admin' })).toString('base64url');
    const tampered = await gw.inject({ method: 'GET', url: '/v1/admin/users', headers: { authorization: `Bearer ${h}.${forgedPayload}.${s}` } });
    expect(tampered.statusCode).toBe(401);
  });

  it('rejects tokens of a revoked session immediately', async () => {
    await redis.set(sessionKeys.revoked('sid-revoked'), '1', 'EX', 60);
    const res = await gw.inject({ method: 'GET', url: '/v1/users/me', headers: await bearer({ sid: 'sid-revoked' }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/session has ended/);
  });

  it('enforces x-roles before the request reaches a service', async () => {
    const customer = await gw.inject({ method: 'GET', url: '/v1/admin/users', headers: await bearer() });
    expect(customer.statusCode).toBe(403);
    const admin = await gw.inject({ method: 'GET', url: '/v1/admin/users', headers: await bearer({ role: 'admin' }) });
    expect(admin.statusCode).toBe(200);
    const officerOnly = await gw.inject({ method: 'POST', url: `/v1/admin/reports/${USER}/review`, headers: await bearer({ role: 'admin' }), payload: {} });
    expect(officerOnly.statusCode).toBe(403);
  });
});

describe('edge behaviour', () => {
  it('404s unknown and internal paths', async () => {
    for (const url of ['/v1/nope', '/internal/identity/users/x']) {
      const res = await gw.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
  });

  it('503s when the owning service is down', async () => {
    const res = await gw.inject({ method: 'GET', url: '/v1/admin/ledger/balances', headers: await bearer({ role: 'admin' }) });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
  });

  it('413s oversized bodies before forwarding', async () => {
    const res = await gw.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: 'x'.repeat(2048) });
    expect(res.statusCode).toBe(413);
  });

  it('rate-limits sensitive routes per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await strict.inject({ method: 'POST', url: '/v1/auth/forgot-password', headers: { 'content-type': 'application/json' }, payload: {} })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await strict.inject({ method: 'POST', url: '/v1/auth/forgot-password', headers: { 'content-type': 'application/json' }, payload: {} });
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Normal routes use their own, larger bucket.
    expect((await strict.inject({ method: 'GET', url: '/v1/corridors' })).statusCode).toBe(200);
  });

  it('sets security headers and allows the web app origin only', async () => {
    const ok = await gw.inject({ method: 'OPTIONS', url: '/v1/users/me', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const evil = await gw.inject({ method: 'GET', url: '/v1/corridors', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(evil.headers['x-content-type-options']).toBe('nosniff');
  });

  it('aggregates service health', async () => {
    const res = await gw.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'degraded', services: { 'identity-service': 'ok', 'ledger-service': 'down' } });
  });
});
