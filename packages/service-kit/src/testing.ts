// Test helpers: prove that what a service returns is exactly what the contract promises.
import type { ValidateFunction } from 'ajv';
import { findOperation } from './contract.ts';
import { createAjv } from './http.ts';

const ajv = createAjv();
const compiled = new Map<string, ValidateFunction>();

/** Throws with a readable message if `body` doesn't match the contract's response schema for (operation, status). */
export function assertMatchesContract(operationId: string, status: number, body: unknown): void {
  const op = findOperation(operationId);
  const response = op.responses[String(status)] ?? op.responses.default;
  if (!response) throw new Error(`${operationId} has no ${status} response in the contract`);
  if (!response.schema) {
    if (body !== undefined && body !== '' && body !== null) throw new Error(`${operationId} ${status} should have no body`);
    return;
  }
  const key = `${operationId}:${status}`;
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(response.schema);
    compiled.set(key, validate);
  }
  if (!validate(body)) {
    throw new Error(`${operationId} ${status} response breaks the contract: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body, null, 2)}`);
  }
}
