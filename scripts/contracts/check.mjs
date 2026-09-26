// AnchorPay-specific API contract rules that the generic OpenAPI linter can't express.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from '../lib/paths.mjs';

export const SERVICES = [
  'gateway', 'identity-service', 'transfer-service', 'payment-service', 'notification-service',
  'compliance-service', 'fx-service', 'ledger-service',
];
const ROLES = ['public', 'customer', 'agent', 'compliance_officer', 'admin', 'provider'];
const INTERNAL_PREFIX_OWNER = {
  '/internal/identity/': 'identity-service',
  '/internal/transfers': 'transfer-service',
  '/internal/compliance/': 'compliance-service',
  '/internal/fx/': 'fx-service',
  '/internal/payments/': 'payment-service',
  '/internal/payouts': 'payment-service',
};
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

const load = (name) => parse(readFileSync(join(ROOT, 'contracts', 'openapi', name), 'utf8'));
const operations = (spec) =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => ({ path, method: m.toUpperCase(), op: item[m] })),
  );

const errors = [];
const where = ({ method, path }) => `${method} ${path}`;

for (const o of operations(load('public-api.yaml'))) {
  if (o.path.startsWith('/internal')) errors.push(`${where(o)}: internal paths must not appear in the public API`);
  if (!SERVICES.includes(o.op['x-owner-service'])) errors.push(`${where(o)}: unknown x-owner-service "${o.op['x-owner-service']}"`);
  const roles = o.op['x-roles'];
  if (!Array.isArray(roles) || roles.length === 0) errors.push(`${where(o)}: x-roles is required`);
  else for (const r of roles) if (!ROLES.includes(r)) errors.push(`${where(o)}: unknown role "${r}"`);
  const isPublic = roles?.includes('public') || roles?.includes('provider');
  const sec = o.op.security;
  const hasNoAuth = Array.isArray(sec) && (sec.length === 0 || sec.some((s) => Object.keys(s).length === 0 || !s.bearerAuth));
  if (isPublic && !hasNoAuth) errors.push(`${where(o)}: public/provider operation must override security`);
  if (!isPublic && hasNoAuth) errors.push(`${where(o)}: operation without JWT must list role public or provider`);
  if (o.path.startsWith('/v1/admin/') && roles?.includes('customer')) errors.push(`${where(o)}: admin endpoints must not allow customers`);
}

for (const o of operations(load('internal-api.yaml'))) {
  if (!o.path.startsWith('/internal/')) errors.push(`${where(o)}: internal API paths must start with /internal/`);
  const owner = o.op['x-owner-service'];
  const expected = Object.entries(INTERNAL_PREFIX_OWNER).find(([prefix]) => o.path.startsWith(prefix))?.[1];
  if (owner !== expected) errors.push(`${where(o)}: x-owner-service should be ${expected} (path prefix), got ${owner}`);
  const callers = o.op['x-callers'];
  if (!Array.isArray(callers) || callers.length === 0) errors.push(`${where(o)}: x-callers is required`);
  else {
    for (const c of callers) if (!SERVICES.includes(c)) errors.push(`${where(o)}: unknown caller "${c}"`);
    if (callers.includes(owner)) errors.push(`${where(o)}: a service must not call its own internal API over HTTP`);
  }
}

if (errors.length) {
  console.error(`API contract rules FAILED (${errors.length}):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log('API contract rules OK (owners, roles, callers, auth).');
