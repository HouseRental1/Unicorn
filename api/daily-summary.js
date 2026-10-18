// Runs every evening from a Vercel cron job (see vercel.json) and emails the owner the day's summary.
// Email sending switches on when RESEND_API_KEY is set and an email address is saved in Settings
// (or SUMMARY_EMAIL is set). Ghana time is UTC, so "today" is the UTC date.
import { q, hasDb, ensureSchema } from './_lib.js';

const fmt = (cur, n) => `${cur} ${(Number(n) || 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isoDay = d => d.toISOString().slice(0, 10);
function addPeriod(start, k, freq) { const d = new Date(start + 'T00:00:00Z'); if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * k); else d.setUTCMonth(d.getUTCMonth() + k); return isoDay(d); }
const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

function planStats(p, today) {
  const paid = (p.payments || []).reduce((a, x) => a + Number(x.amount || 0), 0);
  if (p.cancelled) return { status: 'cancelled' };
  const balance = Math.max(0, p.total - paid);
  if (balance <= 0.009) return { status: 'paid' };
  let due = 0; for (let k = 1; k <= p.count; k++) if (addPeriod(p.startDate, k, p.freq) <= today) due++;
  const expected = Math.min(p.total, p.deposit + p.instalment * due);
  const covered = Math.min(p.count, Math.floor((paid - p.deposit + 0.01) / p.instalment));
  const nextDue = covered < p.count ? addPeriod(p.startDate, covered + 1, p.freq) : null;
  if (paid + 0.01 < expected) return { status: 'overdue', arrears: expected - paid, late: days(nextDue, today) };
  if (nextDue && days(today, nextDue) <= 3) return { status: 'soon', nextDue };
  return { status: 'ontrack' };
}

export async function buildSummary(today = isoDay(new Date())) {
  const rows = await q(`select col, id, data from shop_docs where not deleted and col in ('sales','plans','products','settings','customers','closes')`);
  const by = c => rows.filter(r => r.col === c).map(r => r.data);
  const settings = by('settings')[0] || {}, cur = settings.currency || 'GH₵', name = settings.name || 'Unicorn Home Appliances';
  const customers = Object.fromEntries(by('customers').map(c => [c.id, c]));
  const cust = id => customers[id]?.name || 'Customer';
  const money = { cash: 0, momo: 0, card: 0, transfer: 0 }; let sold = 0, n = 0, refunds = 0, planIn = 0;
  for (const s of by('sales')) {
    if (s.date.slice(0, 10) === today) { n++; sold += s.total; if (s.method !== 'installment') money[s.method] = (money[s.method] || 0) + s.total; }
    for (const r of s.returns || []) if (r.date === today) { money[r.method] = (money[r.method] || 0) - r.refund; refunds += r.refund; sold -= r.refund; }
  }
  for (const p of by('plans')) for (const x of p.payments || []) if (x.date === today) { money[x.method] = (money[x.method] || 0) + x.amount; planIn += x.amount; }
  const total = Object.values(money).reduce((a, b) => a + b, 0);
  const plans = by('plans').map(p => ({ p, st: planStats(p, today) }));
  const overdue = plans.filter(x => x.st.status === 'overdue').sort((a, b) => b.st.late - a.st.late);
  const soon = plans.filter(x => x.st.status === 'soon');
  const low = by('products').filter(p => p.stock <= (p.reorderAt ?? 2)).sort((a, b) => a.stock - b.stock);
  const close = by('closes').find(c => c.date === today);
  const label = { cash: 'Cash', momo: 'Mobile money', card: 'Card', transfer: 'Bank transfer' };
  const L = [`${name}`, `Daily summary for ${new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`, '',
    `Sales: ${n} · ${fmt(cur, sold)}`, `Money in: ${fmt(cur, total)}`];
  const parts = Object.entries(money).filter(([, v]) => v).map(([k, v]) => `${label[k]} ${fmt(cur, v)}`); if (parts.length) L.push('  ' + parts.join(' · '));
  if (planIn) L.push(`Plan payments and deposits: ${fmt(cur, planIn)}`);
  if (refunds) L.push(`Refunds: ${fmt(cur, refunds)}`);
  L.push('', close ? `Day close: cash difference ${fmt(cur, close.diff?.cash)}, MoMo difference ${fmt(cur, close.diff?.momo)}` : 'Day close: not done');
  L.push('', `Overdue customers: ${overdue.length}`); overdue.slice(0, 15).forEach(x => L.push(`  - ${cust(x.p.customerId)}: ${fmt(cur, x.st.arrears)}, ${x.st.late} days late`));
  if (soon.length) { L.push(`Due in the next 3 days: ${soon.length}`); soon.slice(0, 15).forEach(x => L.push(`  - ${cust(x.p.customerId)}: ${fmt(cur, x.p.instalment)} on ${x.st.nextDue}`)); }
  L.push('', `Low stock: ${low.length}`); low.slice(0, 20).forEach(p => L.push(`  - ${p.brand} ${p.name}: ${p.stock === 0 ? 'sold out' : p.stock + ' left'}`));
  const toDeliver = by('sales').filter(s => s.channel === 'online' && (s.deliveryStatus || 'pending') !== 'delivered' && (s.returns || []).flatMap(r => r.units || []).length < s.items.reduce((a, i) => a + i.qty, 0)).length;
  if (toDeliver) L.push('', `Online orders still to deliver: ${toDeliver}`);
  return { name, email: settings.summaryEmail || process.env.SUMMARY_EMAIL || '', text: L.join('\n') };
}

export default async function handler(req, res) {
  const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(401, { ok: false, message: 'Not allowed.' });
  if (!hasDb()) return send(200, { ok: false, message: 'No database connected.' });
  await ensureSchema();
  const sum = await buildSummary();
  if (!process.env.RESEND_API_KEY) return send(200, { ok: true, sent: false, message: 'Email sending is not switched on (RESEND_API_KEY is not set).' });
  if (!sum.email) return send(200, { ok: true, sent: false, message: 'No summary email address saved in Settings.' });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.SUMMARY_FROM || `${sum.name} <onboarding@resend.dev>`, to: [sum.email], subject: `${sum.name}: daily summary`, text: sum.text }),
  });
  const detail = await r.text();
  if (!r.ok) { console.error('summary email failed', r.status, detail); return send(502, { ok: false, sent: false, message: 'The email service refused the message.', status: r.status }); }
  return send(200, { ok: true, sent: true });
}
