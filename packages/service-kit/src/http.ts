// createService(): the Fastify setup every AnchorPay service shares.
//  - request ids (X-Request-Id), structured logs with secrets redacted, problem+json errors
//  - request validation with the JSON Schemas from the OpenAPI contract (Ajv, JSON Schema 2020-12)
//  - routes registered by operationId, so method/path/schema/roles always match the contract
//  - public operations only accept requests forwarded by the gateway (X-Internal-Token) and check
//    the caller's role; internal operations only accept services listed in x-callers
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { loadOperations, type Operation } from './contract.ts';
import { env } from './env.ts';
import { AppError, installErrorHandling } from './errors.ts';
import { requestIdFrom, safeEqual, UUID } from './ids.ts';
import { createLogger, type Logger } from './logger.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export const ROLES = ['customer', 'agent', 'compliance_officer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthContext {
  userId: string;
  role: Role;
  sessionId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    caller: string | null;
  }
  interface FastifyContextConfig {
    operation?: Operation;
  }
}

/** Headers the gateway sets after authenticating a user. Services trust them only with a valid X-Internal-Token. */
export const IDENTITY_HEADERS = {
  internalToken: 'x-internal-token',
  userId: 'x-user-id',
  role: 'x-user-role',
  sessionId: 'x-session-id',
  callingService: 'x-calling-service',
} as const;

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: 'array', useDefaults: true });
  addFormats(ajv);
  ajv.addFormat('int64', true);
  ajv.addFormat('int32', true);
  return ajv;
}

export type HealthChecks = Record<string, () => Promise<unknown>>;

export interface ServiceOptions {
  name: string;
  logger?: Logger;
  health?: HealthChecks;
  bodyLimit?: number;
}

export type OperationHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface Service {
  app: FastifyInstance;
  log: Logger;
  /** Registers the handler for a contract operation owned by this service. */
  handle(operationId: string, handler: OperationHandler): void;
  /** Contract operations owned by this service that have no handler yet. */
  unhandled(): string[];
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

async function authorize(request: FastifyRequest): Promise<void> {
  const op = request.routeOptions.config.operation;
  if (!op) return; // /health and unknown routes

  const token = header(request, IDENTITY_HEADERS.internalToken);
  if (!token || !safeEqual(token, env('INTERNAL_SERVICE_TOKEN'))) {
    throw new AppError(
      'UNAUTHENTICATED',
      op.spec === 'internal' ? 'Missing or invalid internal service token.' : 'Requests must come through the API gateway.',
    );
  }

  if (op.spec === 'internal') {
    const caller = header(request, IDENTITY_HEADERS.callingService);
    if (!caller || !op.callers.includes(caller)) throw new AppError('FORBIDDEN', `${caller ?? 'Unknown caller'} may not call ${op.operationId}.`);
    request.caller = caller;
    return;
  }

  const userId = header(request, IDENTITY_HEADERS.userId);
  const role = header(request, IDENTITY_HEADERS.role);
  if (userId && role) {
    if (!UUID.test(userId) || !(ROLES as readonly string[]).includes(role)) throw new AppError('UNAUTHENTICATED', 'Malformed identity headers.');
    request.auth = { userId, role: role as Role, sessionId: header(request, IDENTITY_HEADERS.sessionId) ?? null };
  }
  if (op.auth === 'required') {
    if (!request.auth) throw new AppError('UNAUTHENTICATED');
    if (!op.roles.includes(request.auth.role)) throw new AppError('FORBIDDEN', 'Your role is not allowed to do this.');
  }
}

export function createService(options: ServiceOptions): Service {
  const log = options.logger ?? createLogger(options.name);
  const app: FastifyInstance = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    trustProxy: '127.0.0.1',
  });
  const ajv = createAjv();
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema as object));
  app.decorateRequest('auth', null);
  app.decorateRequest('caller', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    await authorize(request);
  });
  installErrorHandling(app);

  app.get('/health', async (_request, reply) => {
    const checks: Record<string, string> = {};
    for (const [name, check] of Object.entries(options.health ?? {})) {
      try {
        await check();
        checks[name] = 'ok';
      } catch {
        checks[name] = 'down';
      }
    }
    const ok = Object.values(checks).every((c) => c === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'down', service: options.name, checkedAt: new Date().toISOString(), checks });
  });

  const owned = new Map(
    [...loadOperations('public'), ...loadOperations('internal')]
      .filter((op) => op.ownerService === options.name)
      .map((op) => [op.operationId, op]),
  );
  const handled = new Set<string>();

  return {
    app,
    log,
    handle(operationId, handler) {
      const op = owned.get(operationId);
      if (!op) throw new Error(`${operationId} is not an operation owned by ${options.name} in the contracts`);
      if (handled.has(operationId)) throw new Error(`${operationId} registered twice`);
      handled.add(operationId);
      const schema = Object.fromEntries(Object.entries(op.schema).filter(([, v]) => v !== undefined));
      app.route({ method: op.method, url: op.routerPath, schema, config: { operation: op }, handler });
    },
    unhandled: () => [...owned.keys()].filter((id) => !handled.has(id)),
  };
}

/** The authenticated user, or 401. Use in handlers of JWT-protected operations. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED');
  return request.auth;
}

export const isStaff = (role: Role) => role !== 'customer';
