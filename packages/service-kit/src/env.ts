import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export class ConfigError extends Error {}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new ConfigError('Could not find the AnchorPay repository root (package.json with "workspaces").');
    dir = parent;
  }
}

/** Absolute path of the monorepo root (where .env and contracts/ live). */
export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

let loaded = false;
/** Loads the root .env once. Real environment variables always win over the file (CI, tests). */
export function loadEnv(): void {
  if (loaded) return;
  const file = join(REPO_ROOT, '.env');
  if (existsSync(file)) dotenv.config({ path: file, quiet: true });
  loaded = true;
}

const isPlaceholder = (v: string) => v === '__ASK__' || v.startsWith('__GENERATE') || v.includes('__HOME__');

/** Reads a required setting; fails loudly when it is missing or still a template placeholder. */
export function env(name: string, fallback?: string): string {
  loadEnv();
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '' || isPlaceholder(value)) {
    throw new ConfigError(`Environment variable ${name} is not set. Run "npm run setup:env" (docs/local-setup.md).`);
  }
  return value;
}

export function envInt(name: string, fallback?: number): number {
  const raw = env(name, fallback === undefined ? undefined : String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`Environment variable ${name} must be an integer, got "${raw}".`);
  return value;
}

export function envOptional(name: string): string | undefined {
  loadEnv();
  const value = process.env[name];
  return value === undefined || value === '' || isPlaceholder(value) ? undefined : value;
}
