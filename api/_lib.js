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
  await q(`create table if not exists shop_account (id int primary key check (id = 1), pw_hash text not null, created_at timestamptz not null default now())`);
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
// The token is bound to the current password hash, so changing the password signs every device out.
export function makeToken(pwHash) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sig = crypto.createHmac('sha256', secret()).update(`v1.${exp}.${pwHash}`).digest('base64url');
  return `v1.${exp}.${sig}`;
}
export function tokenValid(token, pwHash) {
  const [v, exp, sig] = String(token || '').split('.');
  if (v !== 'v1' || !exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', secret()).update(`v1.${exp}.${pwHash}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export async function account() {
  const rows = await q(`select pw_hash from shop_account where id = 1`);
  return rows[0] || null;
}

/* ---------- Validation ---------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
export const validSeg = s => typeof s === 'string' && SEG.test(s) && s !== '.' && s !== '..';
export class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
