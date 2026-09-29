import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.ts';
import { createService, requireAuth } from '../src/http.ts';
import { InternalClient } from '../src/internal-client.ts';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const USER = '0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b';
const viaGateway = (role = 'customer') => ({ 'x-internal-token': TOKEN, 'x-user-id': USER, 'x-user-role': role, 'x-session-id': 's1' });

// A throwaway service that owns identity-service's operations but only implements a few.
const svc = createService({ name: 'identity-service', health: { ok: async () => 1, broken: async () => { throw new Error('x'); } } });
svc.handle('getMe', async (req) => ({ id: requireAuth(req).userId }));
svc.handle('registerUser', async (_req, reply) => reply.code(201).send({ ok: true }));
svc.handle('adminUpdateUser', async () => ({ ok: true }));
let calls = 0;
svc.handle('internalGetUser', async (req) => {
  const { userId } = req.params as { userId: string };
  if (userId === '00000000-0000-7000-8000-000000000404') throw new AppError('NOT_FOUND', 'No such user');
  if (userId === '00000000-0000-7000-8000-000000000500') {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
  }
  return { id: userId, caller: req.caller };
});
let baseUrl = '';

beforeAll(async () => {
  await svc.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(svc.app.server.address() as AddressInfo).port}`;
});
afterAll(() => svc.app.close());

describe('createService: gateway-only public routes', () => {
  it('rejects requests that bypass the gateway', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', detail: 'Requests must come through the API gateway.' });
  });

  it('rejects a wrong gateway token', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/users/me', headers: { ...viaGateway(), 'x-internal-token': 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires a user for JWT-protected operations', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/users/me', headers: { 'x-internal-token': TOKEN } });
    expect(res.statusCode).toBe(401);
  });

  it('passes an authenticated user through and echoes the request id', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/users/me', headers: { ...viaGateway(), 'x-request-id': 'req_test1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: USER });
    expect(res.headers['x-request-id']).toBe('req_test1');
  });

  it('enforces x-roles from the contract', async () => {
    const url = `/v1/admin/users/${USER}`;
    const denied = await svc.app.inject({ method: 'PATCH', url, headers: viaGateway('customer'), payload: { status: 'active' } });
    expect(denied.statusCode).toBe(403);
    const allowed = await svc.app.inject({ method: 'PATCH', url, headers: viaGateway('admin'), payload: { status: 'active' } });
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects malformed identity headers', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/users/me', headers: { ...viaGateway(), 'x-user-role': 'superuser' } });
    expect(res.statusCode).toBe(401);
  });

  it('validates bodies against the contract schema with field-level errors', async () => {
    const res = await svc.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { 'x-internal-token': TOKEN },
      payload: { email: 'not-an-email', password: 'short', country: 'US' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    const fields = body.errors.map((e: { field: string }) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'country', 'phone', 'fullName']));
  });

  it('turns malformed JSON into a VALIDATION_ERROR', async () => {
    const res = await svc.app.inject({
      method: 'POST', url: '/v1/users', headers: { 'x-internal-token': TOKEN, 'content-type': 'application/json' }, payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('returns problem+json 404 for unknown routes', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('reports health per dependency', async () => {
    const res = await svc.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ ok: 'ok', broken: 'down' });
  });

  it('refuses to register operations it does not own, or twice', () => {
    expect(() => svc.handle('createTransfer', async () => ({}))).toThrow(/not an operation owned/);
    expect(() => svc.handle('getMe', async () => ({}))).toThrow(/registered twice/);
    expect(svc.unhandled()).toContain('login');
  });
});

describe('internal API + InternalClient', () => {
  it('allows listed callers only', async () => {
    const res = await svc.app.inject({
      method: 'GET', url: `/internal/identity/users/${USER}`, headers: { 'x-internal-token': TOKEN, 'x-calling-service': 'fx-service' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('calls another service with token, caller and request id', async () => {
    const client = new InternalClient('compliance-service');
    const res = await client.call<{ id: string; caller: string }>('identity-service', 'GET', `/internal/identity/users/${USER}`, {
      requestId: 'req_x', baseUrl,
    });
    expect(res.body).toEqual({ id: USER, caller: 'compliance-service' });
  });

  it('maps problem responses to AppError with the same code', async () => {
    const client = new InternalClient('compliance-service');
    await expect(
      client.call('identity-service', 'GET', '/internal/identity/users/00000000-0000-7000-8000-000000000404', { requestId: 'r', baseUrl }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('retries idempotent calls on 5xx', async () => {
    const client = new InternalClient('compliance-service');
    const res = await client.call('identity-service', 'GET', '/internal/identity/users/00000000-0000-7000-8000-000000000500', {
      requestId: 'r', baseUrl, retries: 3,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('reports an unreachable service as SERVICE_UNAVAILABLE', async () => {
    const client = new InternalClient('compliance-service');
    await expect(
      client.call('identity-service', 'GET', '/internal/identity/users/x', { requestId: 'r', baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
