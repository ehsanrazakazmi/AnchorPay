// The gateway's route table, built from contracts/openapi/public-api.yaml (x-owner-service, x-roles,
// security). Routes can't drift from the contract, and /internal paths are never reachable.
import { loadOperations, type Operation } from '@anchorpay/service-kit';

export interface Route {
  op: Operation;
  regex: RegExp;
  literalSegments: number;
}

function compile(op: Operation): Route {
  const segments = op.path.split('/').filter(Boolean);
  const pattern = segments.map((s) => (s.startsWith('{') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return { op, regex: new RegExp(`^/${pattern}/?$`), literalSegments: segments.filter((s) => !s.startsWith('{')).length };
}

/** Most specific first, so /v1/admin/reports/daily-summary wins over /v1/admin/reports/{reportId}. */
export function buildRouteTable(ops: Operation[] = loadOperations('public')): Route[] {
  return ops.map(compile).sort((a, b) => b.literalSegments - a.literalSegments);
}

export function matchRoute(routes: Route[], method: string, path: string): Route | undefined {
  return routes.find((r) => r.op.method === method && r.regex.test(path));
}

/** Operations whose abuse is costly (credential stuffing, spam): stricter rate limit bucket. */
export const SENSITIVE_OPERATIONS = new Set([
  'registerUser', 'login', 'refreshToken', 'forgotPassword', 'resetPassword', 'verifyEmail', 'verifyPhone', 'resendVerification',
]);
