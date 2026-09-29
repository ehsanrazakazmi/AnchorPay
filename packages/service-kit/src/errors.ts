// RFC 9457 problem details with the stable error codes from contracts/openapi/common.yaml (ErrorCode).
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  EMAIL_NOT_VERIFIED: 422,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATE_TRANSITION: 409,
  QUOTE_EXPIRED: 409,
  RATE_LOCK_EXPIRED: 409,
  KYC_REQUIRED: 422,
  LIMIT_EXCEEDED: 422,
  CORRIDOR_UNAVAILABLE: 422,
  PAYMENT_DECLINED: 422,
  RATE_LIMITED: 429,
  INVALID_SIGNATURE: 400,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Validation failed',
  UNAUTHENTICATED: 'Authentication required',
  INVALID_CREDENTIALS: 'Invalid email or password',
  ACCOUNT_LOCKED: 'Account temporarily locked',
  EMAIL_NOT_VERIFIED: 'Email not verified',
  FORBIDDEN: 'Not allowed',
  NOT_FOUND: 'Not found',
  ALREADY_EXISTS: 'Already exists',
  CONFLICT: 'Conflict',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused with a different request',
  INVALID_STATE_TRANSITION: 'Action not allowed in the current state',
  QUOTE_EXPIRED: 'Quote expired',
  RATE_LOCK_EXPIRED: 'Rate lock expired',
  KYC_REQUIRED: 'Identity verification required',
  LIMIT_EXCEEDED: 'Limit exceeded',
  CORRIDOR_UNAVAILABLE: 'Corridor unavailable',
  PAYMENT_DECLINED: 'Payment declined',
  RATE_LIMITED: 'Too many requests',
  INVALID_SIGNATURE: 'Invalid signature',
  INTERNAL_ERROR: 'Internal error',
  SERVICE_UNAVAILABLE: 'Service unavailable',
};

export interface FieldError {
  field: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  requestId: string;
  errors?: FieldError[];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(code: ErrorCode, detail?: string, options: { status?: number; errors?: FieldError[]; headers?: Record<string, string> } = {}) {
    super(detail ?? TITLES[code]);
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.errors = options.errors;
    this.headers = options.headers;
  }
}

export function problem(code: ErrorCode, requestId: string, detail?: string, status?: number, errors?: FieldError[]): Problem {
  const body: Problem = {
    type: `https://docs.anchorpay.local/errors/${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[code],
    status: status ?? ERROR_STATUS[code],
    code,
    requestId,
  };
  if (detail) body.detail = detail;
  if (errors?.length) body.errors = errors;
  return body;
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}

interface AjvLikeError {
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

function fieldErrors(err: FastifyError): FieldError[] {
  const context = (err as { validationContext?: string }).validationContext;
  return (err.validation as AjvLikeError[] | undefined ?? []).map((v) => {
    const segments = (v.instancePath ?? '').split('/').filter(Boolean);
    const missing = v.params?.missingProperty;
    if (typeof missing === 'string') segments.push(missing);
    const field = segments.join('.') || context || 'body';
    return { field, message: v.message ?? 'is invalid' };
  });
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      if (err.status >= 500) request.log.error({ err }, err.message);
      return sendProblem(reply, problem(err.code, requestId, err.message, err.status, err.errors));
    }
    if (err.validation) {
      return sendProblem(reply, problem('VALIDATION_ERROR', requestId, 'One or more fields are invalid.', 400, fieldErrors(err)));
    }
    const status = err.statusCode ?? 500;
    if (status === 429) return sendProblem(reply, problem('RATE_LIMITED', requestId, err.message, 429));
    if (status >= 400 && status < 500) {
      // Malformed JSON, body too large, unsupported media type, ...: client errors from Fastify itself.
      return sendProblem(reply, problem('VALIDATION_ERROR', requestId, err.message, status));
    }
    request.log.error({ err }, 'unhandled error');
    return sendProblem(reply, problem('INTERNAL_ERROR', requestId, 'Something went wrong. Please try again.', 500));
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, problem('NOT_FOUND', request.id, `No route for ${request.method} ${request.url.split('?')[0]}`)),
  );
}
