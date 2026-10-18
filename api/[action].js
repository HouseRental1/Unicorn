import { q, tx, hasDb, ensureSchema, hashPassword, checkPassword, makeToken, tokenValid, account, validSeg, HttpError } from './_lib.js';
import seedDocs from './_seed.js';

const json = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
const rowOut = r => ({ col: r.col, id: r.id, data: r.data, deleted: r.deleted, rev: Number(r.rev) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function requireAuth(req) {
  const acct = await account();
  if (!acct) throw new HttpError(409, 'not_setup', 'The shop has not been set up yet.');
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenValid(token, acct.pw_hash)) throw new HttpError(401, 'auth', 'Please sign in again.');
  return acct;
}
function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { throw new HttpError(400, 'invalid_argument', 'The request was not valid JSON.'); }
}
function checkPw(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'invalid_argument', 'Use a password of at least 8 characters.');
}

const SET = `insert into shop_docs (col, id, data, deleted, rev, updated_at) values ($1, $2, $3::jsonb, false, nextval('shop_rev'), now())
  on conflict (col, id) do update set data = excluded.data, deleted = false, rev = excluded.rev, updated_at = now()
  returning col, id, data, deleted, rev`;
const UPDATE = `update shop_docs set data = data || $3::jsonb, rev = nextval('shop_rev'), updated_at = now()
  where col = $1 and id = $2 and not deleted returning col, id, data, deleted, rev`;
const DELETE = `update shop_docs set deleted = true, data = null, rev = nextval('shop_rev'), updated_at = now()
  where col = $1 and id = $2 returning col, id, data, deleted, rev`;

const actions = {
  async status() {
    if (!hasDb()) return { db: false, setup: false, configured: Boolean(process.env.SESSION_SECRET && process.env.SETUP_CODE) };
    await ensureSchema();
    return { db: true, setup: Boolean(await account()), configured: Boolean(process.env.SESSION_SECRET && process.env.SETUP_CODE) };
  },

  async setup(req) {
    const b = body(req);
    if (!process.env.SETUP_CODE || String(b.code || '').trim().toUpperCase() !== process.env.SETUP_CODE.toUpperCase()) { await sleep(600); throw new HttpError(403, 'bad_code', 'That setup code is not right.'); }
    checkPw(b.password);
    if (await account()) throw new HttpError(409, 'already_setup', 'This shop is already set up. Sign in instead.');
    const pwHash = hashPassword(b.password);
    const made = await q(`insert into shop_account (id, pw_hash) values (1, $1) on conflict (id) do nothing returning id`, [pwHash]);
    if (!made.length) throw new HttpError(409, 'already_setup', 'This shop is already set up. Sign in instead.');
    if (b.seed) {
      const [{ n }] = await q(`select count(*)::int as n from shop_docs`);
      if (!n) for (let i = 0; i < seedDocs.length; i += 40)
        await tx(seedDocs.slice(i, i + 40).map(d => [SET, [d.col, d.id, JSON.stringify(d.data)]]));
    }
    return { token: makeToken(pwHash) };
  },

  async login(req) {
    const b = body(req);
    const acct = await account();
    if (!acct) throw new HttpError(409, 'not_setup', 'The shop has not been set up yet.');
    if (!checkPassword(String(b.password || ''), acct.pw_hash)) { await sleep(700); throw new HttpError(403, 'bad_password', 'That password is not right.'); }
    return { token: makeToken(acct.pw_hash) };
  },

  async password(req) {
    const acct = await requireAuth(req);
    const b = body(req);
    if (!checkPassword(String(b.current || ''), acct.pw_hash)) { await sleep(700); throw new HttpError(403, 'bad_password', 'The current password is not right.'); }
    checkPw(b.next);
    const pwHash = hashPassword(b.next);
    await q(`update shop_account set pw_hash = $1 where id = 1`, [pwHash]);
    return { token: makeToken(pwHash) };
  },

  async sync(req) {
    await requireAuth(req);
    const since = Math.max(0, Number(req.query.since) || 0);
    // A short overlap window catches writes that committed slightly out of order.
    const rows = await q(`select col, id, data, deleted, rev from shop_docs where rev > $1 or (updated_at > now() - interval '20 seconds' and $1 > 0) order by rev limit 5000`, [since]);
    const docs = rows.map(rowOut);
    return { docs, rev: docs.reduce((m, d) => Math.max(m, d.rev), since), more: rows.length === 5000 };
  },

  async doc(req) {
    await requireAuth(req);
    const { col, id } = req.query;
    if (!validSeg(col) || !validSeg(id)) throw new HttpError(400, 'invalid_argument', 'Bad document path.');
    const rows = await q(`select col, id, data, deleted, rev from shop_docs where col = $1 and id = $2 and not deleted`, [col, id]);
    return rows[0] ? { exists: true, ...rowOut(rows[0]) } : { exists: false };
  },

  async write(req) {
    await requireAuth(req);
    const ops = body(req).ops;
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) throw new HttpError(400, 'invalid_argument', 'Send between 1 and 100 changes.');
    for (const o of ops) {
      if (!['set', 'update', 'delete'].includes(o.op) || !validSeg(o.col) || !validSeg(o.id)) throw new HttpError(400, 'invalid_argument', 'Bad change.');
      if (o.op !== 'delete' && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data))) throw new HttpError(400, 'invalid_argument', 'A document must be an object.');
      if (o.op !== 'delete' && JSON.stringify(o.data).length > 256 * 1024) throw new HttpError(400, 'invalid_argument', 'That record is too large.');
    }
    const upd = ops.filter(o => o.op === 'update');
    for (const o of upd) {
      const r = await q(`select 1 from shop_docs where col = $1 and id = $2 and not deleted`, [o.col, o.id]);
      if (!r.length) throw new HttpError(400, 'invalid_argument', `Record ${o.col}/${o.id} no longer exists.`);
    }
    const results = await tx(ops.map(o => o.op === 'set' ? [SET, [o.col, o.id, JSON.stringify(o.data)]]
      : o.op === 'update' ? [UPDATE, [o.col, o.id, JSON.stringify(o.data)]] : [DELETE, [o.col, o.id]]));
    return { docs: results.flat().map(rowOut) };
  },

  async lock(req) {
    await requireAuth(req);
    const b = body(req);
    const key = String(b.key || ''), holder = String(b.holder || '');
    if (!key || key.length > 400 || !holder || holder.length > 100) throw new HttpError(400, 'invalid_argument', 'Bad lock request.');
    const ttl = Math.min(600000, Math.max(1000, Number(b.ttl) || 30000));
    const rows = await q(`insert into shop_locks (key, holder, expires_at) values ($1, $2, now() + $3 * interval '1 millisecond')
      on conflict (key) do update set holder = excluded.holder, expires_at = excluded.expires_at
      where shop_locks.expires_at < now() or shop_locks.holder = excluded.holder returning holder`, [key, holder, ttl]);
    return { acquired: rows.length === 1 && rows[0].holder === holder };
  },
};
const POST_ONLY = new Set(['setup', 'login', 'password', 'write', 'lock']);

export default async function handler(req, res) {
  const name = String(req.query.action || '');
  const fn = actions[name];
  if (!fn) return json(res, 404, { code: 'not_found', message: 'Unknown action.' });
  if (POST_ONLY.has(name) && req.method !== 'POST') return json(res, 405, { code: 'method', message: 'Use POST.' });
  try {
    if (name !== 'status') { if (!hasDb()) throw new HttpError(503, 'no_db', 'The database is not connected yet.'); await ensureSchema(); }
    return json(res, 200, await fn(req));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(name, e);
    return json(res, status, { code: e.code || 'unavailable', message: status >= 500 && !e.code ? 'Something went wrong on the server. Try again.' : e.message });
  }
}
