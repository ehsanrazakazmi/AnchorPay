// Runs the project's Python (.venv) with the given arguments, on Windows and Linux alike.
//   node scripts/py.mjs setup          create .venv and install every Python package (editable) + test tools
//   node scripts/py.mjs <python args>  e.g. -m pytest, -m ruff check ...
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/paths.mjs';

const venvPython = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Python packages and services, i.e. every folder with a pyproject.toml. */
export function pythonProjects() {
  const found = [];
  for (const group of ['packages', 'services']) {
    for (const name of readdirSync(join(ROOT, group))) {
      if (existsSync(join(ROOT, group, name, 'pyproject.toml'))) found.push(`${group}/${name}`);
    }
  }
  // The shared kit first, so services resolve it from the local folder rather than PyPI.
  return found.sort((a, b) => Number(b.includes('py-service-kit')) - Number(a.includes('py-service-kit')));
}

const args = process.argv.slice(2);
if (args[0] === 'setup') {
  if (!existsSync(venvPython)) run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  const projects = pythonProjects();
  run(venvPython, ['-m', 'pip', 'install', '--quiet', ...projects.flatMap((p) => ['-e', p.includes('py-service-kit') ? `${p}[test]` : p])]);
  console.log(`Python ready: ${projects.join(', ')}`);
} else {
  if (!existsSync(venvPython)) {
    console.error('No .venv yet. Run "npm run py:setup" first (needs Python 3.12+).');
    process.exit(1);
  }
  run(venvPython, args);
}
