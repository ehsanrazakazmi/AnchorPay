// npm run docs:api — browse the OpenAPI contracts in Swagger UI at http://127.0.0.1:8090
// Serves only swagger-ui-dist assets and the YAML files in contracts/openapi, bound to localhost.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { env } from './lib/env.mjs';
import { ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const UI_DIR = dirname(require.resolve('swagger-ui-dist/package.json'));
const SPEC_DIR = join(ROOT, 'contracts', 'openapi');
const PORT = Number(env('API_DOCS_PORT', '8090'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.yaml': 'application/yaml', '.html': 'text/html' };

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AnchorPay API contracts</title>
<link rel="stylesheet" href="/ui/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="/ui/swagger-ui-bundle.js"></script>
<script src="/ui/swagger-ui-standalone-preset.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    dom_id: '#ui',
    urls: [
      { url: '/specs/public-api.yaml', name: 'Public API (gateway)' },
      { url: '/specs/internal-api.yaml', name: 'Internal API (service-to-service)' }
    ],
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    deepLinking: true,
    displayOperationId: true,
    tryItOutEnabled: false
  });
</script></body></html>`;

// Resolves a request path inside base, refusing anything that escapes it (e.g. ../../.env).
function safeFile(base, relative) {
  const full = normalize(join(base, relative));
  if (!full.startsWith(base + sep)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (pathname === '/') return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(INDEX);

  let file = null;
  if (pathname.startsWith('/ui/')) file = safeFile(UI_DIR, decodeURIComponent(pathname.slice(4)));
  else if (pathname.startsWith('/specs/') && pathname.endsWith('.yaml')) file = safeFile(SPEC_DIR, decodeURIComponent(pathname.slice(7)));
  if (!file) return res.writeHead(404).end('Not found');

  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => console.log(`API docs: http://127.0.0.1:${PORT}  (Ctrl+C to stop)`));
