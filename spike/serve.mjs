// Static servers for the stage 0 checks.
//   8601 editor build, embeddable only from http://localhost:8602 (frame-ancestors)
//   8602 test host page (the allowed origin)
//   8603 test host page on an origin that is NOT allowed
//   8604 editor build without frame-ancestors, to test message origin checks in isolation
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.cur': 'image/x-icon'};

const serve = (dir, port, headers) => http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', ...headers});
    fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port} -> ${path.relative(root, dir)}`));

const build = path.join(root, 'build');
const host = path.join(root, 'spike/host');
serve(build, 8601, {'Content-Security-Policy': "frame-ancestors http://localhost:8602"});
serve(host, 8602, {});
serve(host, 8603, {});
serve(build, 8604, {});
