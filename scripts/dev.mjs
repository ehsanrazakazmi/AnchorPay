// npm run dev [-- identity-service gateway ...]
// Starts every service in services/* that has src/server.ts (or only the ones named), with auto-restart
// on code changes and each output line prefixed with the service name. Ctrl+C stops them all.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/paths.mjs';

const isNode = (s) => existsSync(join(ROOT, 'services', s, 'src', 'server.ts'));
const pyModule = (s) => s.replaceAll('-', '_');
const isPython = (s) => existsSync(join(ROOT, 'services', s, 'src', pyModule(s), '__main__.py'));
const available = readdirSync(join(ROOT, 'services')).filter((s) => isNode(s) || isPython(s));
const venvPython = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const wanted = process.argv.slice(2);
const unknown = wanted.filter((s) => !available.includes(s));
if (unknown.length) {
  console.error(`Unknown service(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  process.exit(1);
}
const services = wanted.length ? wanted : available;
const width = Math.max(...services.map((s) => s.length));
const colors = [36, 35, 33, 32, 34, 31];
const watch = !process.env.NO_WATCH;

const children = services.map((name, i) => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // Python services run without auto-reload: restart them (Ctrl+C, npm run dev) after changing their code.
  const [cmd, args] = isNode(name)
    ? [process.execPath, [tsx, ...(watch ? ['watch', '--clear-screen=false'] : []), join('services', name, 'src', 'server.ts')]]
    : [venvPython, ['-m', pyModule(name)]];
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  const prefix = `\x1b[${colors[i % colors.length]}m${name.padEnd(width)}\x1b[0m |`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) console.log(`${prefix} ${line}`);
    });
  }
  child.on('exit', (code) => console.log(`${prefix} exited (${code})`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
