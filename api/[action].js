import crypto from 'node:crypto';
import { q, tx, hasDb, ensureSchema, hashPassword, checkPassword, makeToken, userFromToken, validSeg, HttpError } from './_lib.js';

const json = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
const rowOut = r => ({ col: r.col, id: r.id, data: r.data, deleted: r.deleted, rev: Number(r.rev) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROLES = ['sales', 'manager', 'owner'];
const RANK = { sales: 1, manager: 5, owner: 9 };

async function requireAuth(req, minRole = 'sales') {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await userFromToken(token);
  if (!user) throw new HttpError(401, 'auth', 'Please sign in again.');
  if ((RANK[user.role] || 0) < RANK[minRole]) throw new HttpError(403, 'forbidden', 'Your login is not allowed to do that.');
  return user;
}
function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { throw new HttpError(400, 'invalid_argument', 'The request was not valid JSON.'); }
}
function checkPw(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'invalid_argument', 'Use a password of at least 8 characters.');
}
function cleanUsername(u) {
  const v = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(v)) throw new HttpError(400, 'invalid_argument', 'Use 3 to 30 letters, numbers, dots, dashes or underscores for the username.');
  return v;
}
function cleanName(n) {
  const v = String(n || '').trim();
  if (!v || v.length > 80) throw new HttpError(400, 'invalid_argument', 'Enter a name of up to 80 characters.');
  return v;
}
const cleanDisc = d => Math.min(100, Math.max(0, Number(d) || 0));
async function staffDoc(id) {
  const r = await q(`select data from shop_docs where col = 'staff' and id = $1 and not deleted`, [id]);
  return r[0]?.data || null;
}
async function userOut(u) {
  const d = await staffDoc(u.id);
  return { id: u.id, username: u.username, role: u.role, name: d?.name || u.username, maxDiscount: d?.maxDiscount ?? (u.role === 'sales' ? 5 : 100) };
}
async function activeOwners(exceptId) {
  const r = await q(`select count(*)::int as n from shop_users where role = 'owner' and active and id <> $1`, [exceptId || '']);
  return r[0].n;
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
    const configured = Boolean(process.env.SESSION_SECRET && process.env.SETUP_CODE);
    if (!hasDb()) return { db: false, setup: false, configured };
    await ensureSchema();
    const [{ n }] = await q(`select count(*)::int as n from shop_users where active`);
    return { db: true, setup: n > 0, configured };
  },

  // First run: creates the owner's login. Needs the setup code from the Vercel settings.
  async setup(req) {
    const b = body(req);
    if (!process.env.SETUP_CODE || String(b.code || '').trim().toUpperCase() !== process.env.SETUP_CODE.toUpperCase()) { await sleep(600); throw new HttpError(403, 'bad_code', 'That setup code is not right.'); }
    const name = cleanName(b.name), username = cleanUsername(b.username); checkPw(b.password);
    const [{ n }] = await q(`select count(*)::int as n from shop_users`);
    if (n) throw new HttpError(409, 'already_setup', 'This shop is already set up. Sign in instead.');
    const id = 'u' + crypto.randomBytes(6).toString('hex');
    const pwHash = hashPassword(b.password);
    await q(`insert into shop_users (id, username, pw_hash, role) values ($1, $2, $3, 'owner')`, [id, username, pwHash]);
    await q(SET, ['staff', id, JSON.stringify({ id, name, username, role: 'owner', maxDiscount: 100, active: true })]);
    const user = { id, username, role: 'owner', pw_hash: pwHash };
    return { token: makeToken(user), user: await userOut(user) };
  },

  async login(req) {
    const b = body(req);
    const username = String(b.username || '').trim().toLowerCase();
    const rows = await q(`select id, username, pw_hash, role, active from shop_users where username = $1`, [username]);
    const u = rows[0];
    if (!u || !u.active || !checkPassword(String(b.password || ''), u.pw_hash)) { await sleep(700); throw new HttpError(403, 'bad_login', 'That username or password is not right.'); }
    return { token: makeToken(u), user: await userOut(u) };
  },

  async me(req) {
    const u = await requireAuth(req);
    return { user: await userOut(u) };
  },

  async password(req) {
    const u = await requireAuth(req);
    const b = body(req);
    if (!checkPassword(String(b.current || ''), u.pw_hash)) { await sleep(700); throw new HttpError(403, 'bad_password', 'Your current password is not right.'); }
    checkPw(b.next);
    const pwHash = hashPassword(b.next);
    await q(`update shop_users set pw_hash = $1 where id = $2`, [pwHash, u.id]);
    return { token: makeToken({ ...u, pw_hash: pwHash }) };
  },

  // Owner only: add staff logins, change roles, reset passwords, turn logins off.
  async users(req) {
    const me = await requireAuth(req, 'owner');
    const b = body(req);
    if (b.op === 'create') {
      const name = cleanName(b.name), username = cleanUsername(b.username); checkPw(b.password);
      const role = ROLES.includes(b.role) ? b.role : 'sales';
      const taken = await q(`select 1 from shop_users where username = $1`, [username]);
      if (taken.length) throw new HttpError(409, 'taken', `The username ${username} is already used.`);
      const id = 'u' + crypto.randomBytes(6).toString('hex');
      await q(`insert into shop_users (id, username, pw_hash, role) values ($1, $2, $3, $4)`, [id, username, hashPassword(b.password), role]);
      const docs = await q(SET, ['staff', id, JSON.stringify({ id, name, username, role, maxDiscount: cleanDisc(b.maxDiscount), active: true })]);
      return { docs: docs.map(rowOut) };
    }
    if (b.op === 'update') {
      const rows = await q(`select id, username, role, active from shop_users where id = $1`, [String(b.id || '')]);
      const u = rows[0];
      if (!u) throw new HttpError(404, 'not_found', 'That login no longer exists.');
      const role = b.role === undefined ? u.role : (ROLES.includes(b.role) ? b.role : u.role);
      const active = b.active === undefined ? u.active : Boolean(b.active);
      if (u.id === me.id && (!active || role !== 'owner')) throw new HttpError(400, 'invalid_argument', 'You cannot remove your own owner access. Ask another owner to do it.');
      if (u.role === 'owner' && (role !== 'owner' || !active) && !(await activeOwners(u.id))) throw new HttpError(400, 'invalid_argument', 'Keep at least one active owner.');
      if (b.password) { checkPw(b.password); await q(`update shop_users set pw_hash = $1 where id = $2`, [hashPassword(b.password), u.id]); }
      await q(`update shop_users set role = $1, active = $2 where id = $3`, [role, active, u.id]);
      const patch = { role, active };
      if (b.name !== undefined) patch.name = cleanName(b.name);
      if (b.maxDiscount !== undefined) patch.maxDiscount = cleanDisc(b.maxDiscount);
      const prev = (await staffDoc(u.id)) || { id: u.id, username: u.username, name: u.username };
      const docs = await q(SET, ['staff', u.id, JSON.stringify({ ...prev, ...patch, id: u.id, username: u.username })]);
      return { docs: docs.map(rowOut) };
    }
    throw new HttpError(400, 'invalid_argument', 'Unknown staff change.');
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
    const user = await requireAuth(req);
    const ops = body(req).ops;
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) throw new HttpError(400, 'invalid_argument', 'Send between 1 and 100 changes.');
    for (const o of ops) {
      if (!['set', 'update', 'delete'].includes(o.op) || !validSeg(o.col) || !validSeg(o.id)) throw new HttpError(400, 'invalid_argument', 'Bad change.');
      if (o.op !== 'delete' && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data))) throw new HttpError(400, 'invalid_argument', 'A record must be an object.');
      if (o.op !== 'delete' && JSON.stringify(o.data).length > 256 * 1024) throw new HttpError(400, 'invalid_argument', 'That record is too large.');
      // Rules the server enforces whatever the app shows.
      if (o.col === 'staff') throw new HttpError(403, 'forbidden', 'Staff logins are changed in Settings by an owner.');
      if ((o.col === 'settings' || o.op === 'delete') && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can do that.');
    }
    for (const o of ops.filter(o => o.op === 'update')) {
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
const POST_ONLY = new Set(['setup', 'login', 'password', 'users', 'write', 'lock']);

export default async function handler(req, res) {
  const name = String(req.query.action || '');
  const fn = Object.hasOwn(actions, name) ? actions[name] : null;
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
