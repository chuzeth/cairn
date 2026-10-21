/** Un serveur statique pour le prototype : `www/`, sans cache, sur 127.0.0.1 seulement. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, 'www');
const port = Number(process.env.PORT ?? 3210);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // Les mesures envoyées par les pages (`?report=1`) : une ligne JSON par mesure.
  if (req.method === 'POST' && url.pathname === '/__stats') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fs.appendFileSync(path.join(import.meta.dirname, 'measures-fluidity.jsonl'), body.trim() + '\n');
      res.writeHead(204).end();
    });
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('absent');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`figure-3d sur http://127.0.0.1:${port}`));
