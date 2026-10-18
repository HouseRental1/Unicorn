// Local stand-in for Vercel: serves public/ and runs api/[action].js against an in-process Postgres (PGlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
globalThis.__TEST_DB__ = {
  __test: true,
  q: async (t, p) => (await pg.query(t, p)).rows,
  tx: async list => pg.transaction(async t => { const out = []; for (const [q, p] of list) out.push((await t.query(q, p || [])).rows); return out; }),
};
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
process.env.SETUP_CODE = 'TILL-TEST-42';
const { default: handler } = await import('../api/[action].js');
const root = path.resolve('public');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    let raw = ''; for await (const c of req) raw += c;
    req.query = { ...Object.fromEntries(u.searchParams), action: u.pathname.slice(5) };
    req.body = raw ? JSON.parse(raw) : {};
    return handler(req, res);
  }
  const f = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
}).listen(Number(process.env.PORT || 5055), () => console.log('ready'));
