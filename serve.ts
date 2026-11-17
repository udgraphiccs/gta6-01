// Port Vela — tiny static server for local play-testing.
//
// Serves the game/ folder beside this file so the game can be played in a
// browser without any build step:
//
//   node serve.ts            # http://localhost:8080
//   node serve.ts --port 9000
//
// Standard library only; nothing is served outside game/.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function portFromArgs(argv: string[]): number {
  const at = argv.indexOf('--port');
  if (at !== -1 && argv[at + 1] !== undefined) {
    const n = Number(argv[at + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    throw new Error(`--port needs a port number, got ${argv[at + 1]}`);
  }
  return 8080;
}

function main(): void {
  const root = resolve(join(dirname(fileURLToPath(import.meta.url)), 'game'));
  const port = portFromArgs(process.argv.slice(2));

  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    let rawPath: string;
    try {
      rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request\n');
      return;
    }
    let target = normalize(join(root, rawPath));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden\n');
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, 'index.html');
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(target).pipe(res);
  });

  server.listen(port, () => {
    console.log(`Port Vela serving at http://localhost:${port}`);
  });
}

main();
