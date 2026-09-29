import { describe, expect, it } from 'vitest';
import { dereference, findOperation, loadOperations } from '../src/contract.ts';
import { AppError, ERROR_CODES, ERROR_STATUS, problem } from '../src/errors.ts';

describe('contract loader', () => {
  it('loads every operation with an owner', () => {
    const ops = [...loadOperations('public'), ...loadOperations('internal')];
    expect(ops.length).toBeGreaterThan(60);
    for (const op of ops) expect(op.ownerService, op.operationId).toBeTruthy();
  });

  it('converts paths and resolves $refs into plain JSON Schema', () => {
    const op = findOperation('getRecipient');
    expect(op.method).toBe('GET');
    expect(op.routerPath).toBe('/v1/recipients/:recipientId');
    expect(op.schema.params).toEqual({
      type: 'object',
      properties: { recipientId: { type: 'string', format: 'uuid' } },
      required: ['recipientId'],
    });
    expect(JSON.stringify(findOperation('createRecipient').schema.body)).not.toContain('$ref');
  });

  it('keeps sibling keywords next to a $ref', () => {
    const quote = dereference({ $ref: 'common.yaml#/components/schemas/Quote' }, 'public-api.yaml');
    expect(quote.properties.totalCharge.description).toMatch(/sendAmount \+ fee/);
    expect(quote.properties.totalCharge.required).toEqual(['amountMinor', 'currency']);
  });

  it('derives the auth mode from security', () => {
    expect(findOperation('login').auth).toBe('none');
    expect(findOperation('getMe').auth).toBe('required');
    expect(findOperation('createQuote').auth).toBe('optional');
    expect(findOperation('stripeWebhook').auth).toBe('provider');
    expect(findOperation('internalGetUser').auth).toBe('internal');
  });

  it('collects required headers, lower-cased', () => {
    expect(findOperation('createTransfer').schema.headers).toMatchObject({ required: ['idempotency-key'] });
  });

  it('exposes roles and callers', () => {
    expect(findOperation('decideReviewCase').roles).toEqual(['compliance_officer', 'admin']);
    expect(findOperation('internalGetRecipient').callers).toContain('payment-service');
  });

  it('fails clearly for unknown operations and broken refs', () => {
    expect(() => findOperation('nope')).toThrow(/not in the contracts/);
    expect(() => dereference({ $ref: '#/components/schemas/Missing' }, 'public-api.yaml')).toThrow(/Unresolvable/);
  });
});

describe('errors', () => {
  it('error codes match contracts/openapi/common.yaml exactly', () => {
    const contractCodes = dereference({ $ref: 'common.yaml#/components/schemas/ErrorCode' }, 'public-api.yaml').enum;
    expect([...ERROR_CODES].sort()).toEqual([...contractCodes].sort());
  });

  it('builds RFC 9457 problem bodies', () => {
    expect(problem('NOT_FOUND', 'req_1', 'No such recipient')).toEqual({
      type: 'https://docs.anchorpay.local/errors/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'No such recipient',
      requestId: 'req_1',
    });
  });

  it('AppError carries code, status and field errors', () => {
    const e = new AppError('VALIDATION_ERROR', 'bad', { errors: [{ field: 'email', message: 'invalid' }] });
    expect(e.status).toBe(ERROR_STATUS.VALIDATION_ERROR);
    expect(e.errors).toHaveLength(1);
    expect(new AppError('ACCOUNT_LOCKED').status).toBe(423);
  });
});
