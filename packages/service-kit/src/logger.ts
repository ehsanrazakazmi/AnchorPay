import pino, { type Logger } from 'pino';
import { env } from './env.ts';

/** Never written to logs: credentials, tokens and payout account numbers. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'headers.authorization',
  'headers["x-internal-token"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.code',
  '*.accountNumber',
  '*.walletNumber',
];

export function createLogger(service: string): Logger {
  return pino({
    level: env('LOG_LEVEL', 'info'),
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
