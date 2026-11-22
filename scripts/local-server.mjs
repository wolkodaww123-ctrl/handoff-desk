// Local smoke test: serves the Worker with Node (no Cloudflare). AI and Nexconn calls need real env.
import http from 'node:http';
import worker from '../src/worker.js';
const env = {
  NEXCONN_APP_KEY: process.env.NEXCONN_APP_KEY || 'placeholder_key',
  NEXCONN_APP_SECRET: process.env.NEXCONN_APP_SECRET || 'placeholder_secret',
  DESK_PIN: process.env.DESK_PIN || '0000',
  AI: { run: async () => ({ response: 'Local test reply from a stub model.' }) },
};
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, {}).catch((e) => new Response(String(e), { status: 500 }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8788, () => console.log('http://localhost:8788'));
