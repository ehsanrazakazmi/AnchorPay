import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import replyFrom from '@fastify/reply-from';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  AppError, env, envInt, IDENTITY_HEADERS, installErrorHandling, problem, requestIdFrom, sendProblem, serviceUrl,
  type AuthContext, type Logger, type Redis,
} from '@anchorpay/service-kit';
import { authenticate } from './auth.ts';
import { buildRouteTable, matchRoute, SENSITIVE_OPERATIONS, type Route } from './routes.ts';

export interface GatewayOptions {
  redis: Redis;
  log: Logger;
  /** service name -> base URL; defaults to serviceUrl(). Tests point services at stubs. */
  upstreams?: Record<string, string>;
  rateLimits?: { defaultPerMinute: number; sensitivePerMinute: number };
  maxBodyBytes?: number;
}

/** Headers a client must never be able to set: only the gateway asserts identity to services. */
const SPOOFABLE = [
  IDENTITY_HEADERS.internalToken, IDENTITY_HEADERS.userId, IDENTITY_HEADERS.role, IDENTITY_HEADERS.sessionId, IDENTITY_HEADERS.callingService,
];

declare module 'fastify' {
  interface FastifyRequest {
    route?: Route;
    user?: AuthContext;
  }
}

export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  const { redis, log } = options;
  const routes = buildRouteTable();
  const maxBody = options.maxBodyBytes ?? 11 * 1024 * 1024; // KYC uploads are up to 10 MB
  const limits = options.rateLimits ?? {
    defaultPerMinute: envInt('RATE_LIMIT_PER_MINUTE', 120),
    sensitivePerMinute: envInt('RATE_LIMIT_SENSITIVE_PER_MINUTE', 10),
  };
  const upstream = (service: string) => options.upstreams?.[service] ?? serviceUrl(service);

  const app: FastifyInstance = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
    requestIdLogLabel: 'requestId',
    trustProxy: false,
  });
  installErrorHandling(app);

  // Bodies are forwarded as the exact bytes received (webhook signatures depend on them), never re-serialised.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxBody }, (_req, body, done) => done(null, body));

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  const origins = new Set([env('WEB_BASE_URL', 'http://127.0.0.1:3000'), 'http://localhost:3000', 'http://127.0.0.1:3000']);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  // In-memory counters: correct for the single local gateway. Several gateways would share a Redis store.
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler', // after onRequest has matched the route, so the bucket is known
    keyGenerator: (req) => `${req.ip}:${req.route && SENSITIVE_OPERATIONS.has(req.route.op.operationId) ? 'sensitive' : 'default'}`,
    max: (req) => (req.route && SENSITIVE_OPERATIONS.has(req.route.op.operationId) ? limits.sensitivePerMinute : limits.defaultPerMinute),
    timeWindow: 60_000,
    errorResponseBuilder: (req, ctx) => {
      const err = new AppError('RATE_LIMITED', `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`) as AppError & { statusCode: number };
      err.statusCode = 429;
      return err;
    },
  });
  await app.register(replyFrom, { undici: { connections: 64, headersTimeout: 15_000, bodyTimeout: 30_000 } });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const path = req.url.split('?')[0]!;
    req.route = matchRoute(routes, req.method, path);
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > maxBody) {
      throw new AppError('VALIDATION_ERROR', `Request body is larger than ${Math.floor(maxBody / 1024 / 1024)} MB.`, { status: 413 });
    }
  });

  app.get('/health', async (_req, reply) => {
    const services = [...new Set(routes.map((r) => r.op.ownerService).filter((s) => s !== 'gateway'))];
    const results = await Promise.all(
      services.map(async (s) => {
        try {
          const res = await fetch(`${upstream(s)}/health`, { signal: AbortSignal.timeout(1000) });
          return [s, res.ok ? 'ok' : 'down'] as const;
        } catch {
          return [s, 'down'] as const;
        }
      }),
    );
    const statuses = Object.fromEntries(results);
    const up = results.filter(([, s]) => s === 'ok').length;
    const status = up === results.length ? 'ok' : up === 0 ? 'down' : 'degraded';
    return reply.code(status === 'down' ? 503 : 200).send({ status, checkedAt: new Date().toISOString(), services: statuses });
  });

  const proxy = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const route = req.route;
    if (!route) return sendProblem(reply, problem('NOT_FOUND', req.id, `No route for ${req.method} ${req.url.split('?')[0]}`));
    const { op } = route;

    if (op.auth === 'required' || (op.auth === 'optional' && req.headers.authorization)) {
      req.user = await authenticate(req.headers.authorization, redis);
      if (!op.roles.includes(req.user.role)) throw new AppError('FORBIDDEN', 'Your role is not allowed to do this.');
    }

    return reply.from(`${upstream(op.ownerService)}${req.url}`, {
      // With contentType set, reply-from sends the Buffer as-is (without it, it would JSON.stringify it).
      ...(Buffer.isBuffer(req.body) ? { body: req.body, contentType: req.headers['content-type'] ?? 'application/octet-stream' } : {}),
      rewriteRequestHeaders: (_original, headers) => {
        const out: Record<string, string | string[] | undefined> = { ...headers };
        for (const h of SPOOFABLE) delete out[h];
        delete out.authorization; // services trust the gateway's identity headers, not raw tokens
        out['x-request-id'] = req.id;
        out['x-forwarded-for'] = req.ip;
        out[IDENTITY_HEADERS.internalToken] = env('INTERNAL_SERVICE_TOKEN');
        if (req.user) {
          out[IDENTITY_HEADERS.userId] = req.user.userId;
          out[IDENTITY_HEADERS.role] = req.user.role;
          if (req.user.sessionId) out[IDENTITY_HEADERS.sessionId] = req.user.sessionId;
        }
        return out as Record<string, string>;
      },
      onError: (errReply, { error }) => {
        req.log.error({ err: error, service: op.ownerService }, 'upstream error');
        sendProblem(errReply as unknown as import('fastify').FastifyReply,
          problem('SERVICE_UNAVAILABLE', req.id, `${op.ownerService} is unavailable. Please try again shortly.`));
      },
    });
  };

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.route({ method, url: '/*', handler: proxy });
  }
  return app;
}
