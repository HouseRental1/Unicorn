import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

/* ---------- Database access ----------
   Uses the Neon database that Vercel connects to this project (DATABASE_URL).
   Tests swap in a local Postgres through globalThis.__TEST_DB__. */
let sqlClient = null;
export function hasDb() {
  return Boolean(globalThis.__TEST_DB__ || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}
function client() {
  if (globalThis.__TEST_DB__) return globalThis.__TEST_DB__;
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  return sqlClient;
}
export async function q(text, params = []) {
  const c = client();
  return c.__test ? c.q(text, params) : c.query(text, params);
}
export async function tx(list) {
  const c = client();
  return c.__test ? c.tx(list) : c.transaction(list.map(([t, p]) => c.query(t, p || [])));
}

let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  await q(`create sequence if not exists shop_rev`);
  await q(`create table if not exists shop_docs (
    col text not null,
    id text not null,
    data jsonb,
    deleted boolean not null default false,
    rev bigint not null,
    updated_at timestamptz not null default now(),
    primary key (col, id))`);
  await q(`create index if not exists shop_docs_rev on shop_docs (rev)`);
  await q(`create table if not exists shop_locks (key text primary key, holder text not null, expires_at timestamptz not null)`);
  await q(`create table if not exists shop_users (
    id text primary key,
    username text not null unique,
    pw_hash text not null,
    role text not null,
    active boolean not null default true,
    created_at timestamptz not null default now())`);
  await q(`create table if not exists shop_logins (
    id bigserial primary key,
    username text not null,
    user_id text,
    ok boolean not null,
    ip text,
    agent text,
    at timestamptz not null default now())`);
  await q(`create index if not exists shop_logins_user on shop_logins (username, at)`);
  await q(`create index if not exists shop_logins_ip on shop_logins (ip, at)`);
  // One-time rename: shops still on a placeholder name become Unicorn Home Appliances.
  await q(`update shop_docs set data = data || '{"name":"Unicorn Home Appliances"}'::jsonb, rev = nextval('shop_rev'), updated_at = now()
    where col = 'settings' and id = 'shop' and not deleted and data->>'name' in ('Home Appliances', 'Home Appliances (sample data)')`);
  schemaReady = true;
}

/* ---------- Passwords and sessions ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !h) return false;
  const got = crypto.scryptSync(pw, salt, 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const SESSION_DAYS = 30;
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw Object.assign(new Error('SESSION_SECRET is not set'), { status: 500, code: 'config' });
  return s;
}
// A session token names the user and is bound to their current password hash,
// so changing or resetting a password signs that person out everywhere.
export function makeToken(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sig = crypto.createHmac('sha256', secret()).update(`v2.${exp}.${user.id}.${user.pw_hash}`).digest('base64url');
  return `v2.${exp}.${user.id}.${sig}`;
}
export async function userFromToken(token) {
  const [v, exp, id, sig] = String(token || '').split('.');
  if (v !== 'v2' || !exp || !id || !sig || Number(exp) < Date.now()) return null;
  const rows = await q(`select id, username, pw_hash, role, active from shop_users where id = $1`, [id]);
  const u = rows[0];
  if (!u || !u.active) return null;
  const want = crypto.createHmac('sha256', secret()).update(`v2.${exp}.${u.id}.${u.pw_hash}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

/* ---------- Validation ---------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
export const validSeg = s => typeof s === 'string' && SEG.test(s) && s !== '.' && s !== '..';
export class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
