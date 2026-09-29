// Service-to-service HTTP calls (contracts/openapi/internal-api.yaml).
import { env, envOptional } from './env.ts';
import { AppError, type ErrorCode, type Problem } from './errors.ts';
import { IDENTITY_HEADERS } from './http.ts';

export const SERVICE_PORT_VARS: Record<string, string> = {
  gateway: 'GATEWAY_PORT',
  'identity-service': 'IDENTITY_SERVICE_PORT',
  'transfer-service': 'TRANSFER_SERVICE_PORT',
  'payment-service': 'PAYMENT_SERVICE_PORT',
  'notification-service': 'NOTIFICATION_SERVICE_PORT',
  'compliance-service': 'COMPLIANCE_SERVICE_PORT',
  'fx-service': 'FX_SERVICE_PORT',
  'ledger-service': 'LEDGER_SERVICE_PORT',
  'mock-providers': 'MOCK_PROVIDERS_PORT',
};

/** Base URL of a service: <NAME>_URL if set (tests, other hosts), else http://127.0.0.1:<port>. */
export function serviceUrl(service: string): string {
  const portVar = SERVICE_PORT_VARS[service];
  if (!portVar) throw new Error(`Unknown service "${service}"`);
  const override = envOptional(`${service.replace('-service', '').toUpperCase().replaceAll('-', '_')}_SERVICE_URL`);
  return override ?? `http://127.0.0.1:${env(portVar)}`;
}

export interface InternalResponse<T> {
  status: number;
  body: T;
}

export interface CallOptions {
  body?: unknown;
  requestId: string;
  timeoutMs?: number;
  /** Only for idempotent calls. Retries on network errors and 5xx with exponential backoff. */
  retries?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class InternalClient {
  private readonly caller: string;

  constructor(caller: string) {
    this.caller = caller;
  }

  async call<T>(service: string, method: string, path: string, options: CallOptions): Promise<InternalResponse<T>> {
    const url = `${options.baseUrl ?? serviceUrl(service)}${path}`;
    const retries = options.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            // Fastify rejects an empty body labelled as JSON, so bodiless calls (capture, void) send no content-type.
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            [IDENTITY_HEADERS.internalToken]: env('INTERNAL_SERVICE_TOKEN'),
            [IDENTITY_HEADERS.callingService]: this.caller,
            'x-request-id': options.requestId,
            ...options.headers,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
        });
        const text = await res.text();
        const body = text ? JSON.parse(text) : undefined;
        if (res.status >= 500 && attempt < retries) throw new Error(`${service} answered ${res.status}`);
        if (!res.ok) {
          const p = body as Partial<Problem> | undefined;
          throw new AppError((p?.code as ErrorCode) ?? 'SERVICE_UNAVAILABLE', p?.detail ?? `${service} answered ${res.status}`, { status: res.status });
        }
        return { status: res.status, body: body as T };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (attempt >= retries) throw new AppError('SERVICE_UNAVAILABLE', `${service} is unavailable (${(err as Error).message}).`);
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
  }
}
