// Reads contracts/openapi and turns every operation into something a service or the gateway can use
// directly: method, router path, JSON schemas for validation, owner, roles/callers and auth mode.
// The contract is the single source of truth — routes are registered by operationId.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from './env.ts';

export type Json = any;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SpecName = 'public' | 'internal';
export type AuthMode = 'required' | 'optional' | 'none' | 'provider' | 'internal';

export interface Operation {
  spec: SpecName;
  operationId: string;
  method: HttpMethod;
  /** OpenAPI template, e.g. /v1/recipients/{recipientId} */
  path: string;
  /** Fastify/find-my-way syntax, e.g. /v1/recipients/:recipientId */
  routerPath: string;
  ownerService: string;
  roles: string[];
  callers: string[];
  auth: AuthMode;
  schema: { body?: Json; params?: Json; querystring?: Json; headers?: Json };
  requestContentType: string | undefined;
  /** false when the operation's requestBody is optional (a missing body is then valid). */
  bodyRequired: boolean;
  responses: Record<string, { contentType: string | undefined; schema: Json }>;
}

const OPENAPI_DIR = join(REPO_ROOT, 'contracts', 'openapi');
const FILES: Record<SpecName, string> = { public: 'public-api.yaml', internal: 'internal-api.yaml' };
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const documents = new Map<string, Json>();
function loadDocument(file: string): Json {
  let doc = documents.get(file);
  if (!doc) {
    doc = parse(readFileSync(join(OPENAPI_DIR, file), 'utf8'));
    documents.set(file, doc);
  }
  return doc;
}

function pointer(doc: Json, ref: string): Json {
  let node = doc;
  for (const part of ref.replace(/^#?\//, '').split('/')) {
    node = node?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (node === undefined) throw new Error(`Unresolvable $ref #${ref}`);
  }
  return node;
}

/** Inlines every $ref (local or into common.yaml). Sibling keys such as description are kept. */
export function dereference(node: Json, file: string, stack: string[] = []): Json {
  if (Array.isArray(node)) return node.map((n) => dereference(n, file, stack));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const [refFile, ref = ''] = node.$ref.split('#');
    const targetFile = refFile || file;
    const key = `${targetFile}#${ref}`;
    if (stack.includes(key)) throw new Error(`Circular $ref ${key}`);
    const { $ref: _ignored, ...siblings } = node;
    const target = dereference(pointer(loadDocument(targetFile), ref), targetFile, [...stack, key]);
    return { ...target, ...dereference(siblings, file, stack) };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, dereference(v, file, stack)]));
}

function authMode(spec: SpecName, security: Json[]): AuthMode {
  if (spec === 'internal') return 'internal';
  if (security.length === 0) return 'none';
  const hasBearer = security.some((s) => 'bearerAuth' in s);
  if (hasBearer && security.some((s) => Object.keys(s).length === 0)) return 'optional';
  if (hasBearer) return 'required';
  return 'provider';
}

function objectSchema(params: Json[], lowerCaseNames = false): Json | undefined {
  if (params.length === 0) return undefined;
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [lowerCaseNames ? p.name.toLowerCase() : p.name, p.schema ?? {}])),
    required: params.filter((p) => p.required).map((p) => (lowerCaseNames ? p.name.toLowerCase() : p.name)),
  };
}

const cache = new Map<SpecName, Operation[]>();

export function loadOperations(spec: SpecName): Operation[] {
  const cached = cache.get(spec);
  if (cached) return cached;
  const file = FILES[spec];
  const doc = loadDocument(file);
  const ops: Operation[] = [];
  for (const [path, rawItem] of Object.entries<Json>(doc.paths)) {
    const item = dereference(rawItem, file);
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = new Map<string, Json>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) params.set(`${p.in}:${p.name}`, p);
      const byLocation = (where: string) => [...params.values()].filter((p) => p.in === where);
      const headerParams = byLocation('header').filter((p) => p.required);
      const content = op.requestBody?.content ?? {};
      const requestContentType = Object.keys(content)[0];
      const responses: Operation['responses'] = {};
      for (const [status, resp] of Object.entries<Json>(op.responses ?? {})) {
        const contentType = Object.keys(resp.content ?? {})[0];
        responses[status] = { contentType, schema: contentType ? resp.content[contentType].schema : undefined };
      }
      ops.push({
        spec,
        operationId: op.operationId,
        method: m.toUpperCase() as HttpMethod,
        path,
        routerPath: path.replace(/\{([^}]+)\}/g, ':$1'),
        ownerService: op['x-owner-service'],
        roles: op['x-roles'] ?? [],
        callers: op['x-callers'] ?? [],
        auth: authMode(spec, op.security ?? doc.security ?? []),
        schema: {
          body: requestContentType === 'application/json' ? content['application/json'].schema : undefined,
          params: objectSchema(byLocation('path')),
          querystring: objectSchema(byLocation('query')),
          headers: objectSchema(headerParams, true),
        },
        requestContentType,
        bodyRequired: op.requestBody?.required === true,
        responses,
      });
    }
  }
  cache.set(spec, ops);
  return ops;
}

export function findOperation(operationId: string): Operation {
  const op = [...loadOperations('public'), ...loadOperations('internal')].find((o) => o.operationId === operationId);
  if (!op) throw new Error(`Operation "${operationId}" is not in the contracts`);
  return op;
}
