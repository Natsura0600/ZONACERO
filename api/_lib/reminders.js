// Recordatorios por WhatsApp. El sitio decide qué mandar; el bot (carpeta whatsapp-bot) los envía.
import crypto from 'node:crypto';
import { redis, getJSON, setJSON } from './db.js';
import { KEYS, HttpError, nowLocal, addDays, toMin, getDays, isValidDate } from './core.js';

const QUIET_FROM = 22 * 60; // no mandar entre las 22 y las 8
const QUIET_TO = 8 * 60;
const MAX_ATTEMPTS = 3;

const LAST_RUN = 'zc:wa:lastrun';

// Quién puede disparar el envío: el cron de Vercel (Authorization: Bearer CRON_SECRET)
// o un cron externo con ?key=CRON_SECRET.
export function cronSecretSet() {
  return Boolean(process.env.CRON_SECRET);
}

export function checkCron(req, query) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) throw new HttpError(503, 'Falta definir CRON_SECRET en Vercel.');
  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String((query && query.key) || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Clave incorrecta.');
}

// Busca los recordatorios que tocan, los manda por WhatsApp y marca el resultado.
export async function runReminders(cfg, req, { source = 'cron' } = {}) {
  const { sendMessages, linkStatus } = await import('./wa.js');
  const linked = (await linkStatus()).linked;
  const messages = linked ? await outbox(cfg, req, true) : [];
  const results = await sendMessages(messages);
  await markResults(results);
  // los avisos de "reclamá tu beneficio" que no pudieron salir en el momento
  const { flushClaims } = await import('./claims.js');
  const claims = linked ? await flushClaims() : { sent: 0, pending: 0 };
  const summary = {
    at: new Date().toISOString(), source,
    linked, found: messages.length, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
    claimsSent: claims.sent,
  };
  await setJSON(LAST_RUN, summary);
  return summary;
}

export async function lastRun() {
  return getJSON(LAST_RUN);
}

const daysBetween = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
};
// minutos desde el momento local A hasta el B
const minutesBetween = (a, b) => daysBetween(a.date, b.date) * 1440 + (b.minutes - a.minutes);

function whatsappNumber(phone, prefix) {
  if (phone.length >= 11) return phone; // ya trae código de país
  return (prefix || '') + phone;
}

// "hoy", "mañana" o "el miércoles 12/11" respecto de la fecha local de hoy.
export function describeWhen(date, today) {
  const diff = daysBetween(today, date);
  const dt = new Date(date + 'T12:00:00Z');
  const wd = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', weekday: 'long' }).format(dt);
  const dm = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', day: 'numeric', month: 'numeric' }).format(dt);
  return { cuando: diff === 0 ? 'hoy' : diff === 1 ? 'mañana' : `el ${wd} ${dm}`, dia: `${wd} ${dm}` };
}

export function renderTemplate(cfg, b, now, siteUrl) {
  const { cuando, dia } = describeWhen(b.date, now.date);
  const vars = {
    nombre: String(b.name || '').split(' ')[0],
    barberia: cfg.business.name,
    cuando,
    dia,
    hora: b.time,
    servicio: b.serviceName,
    barbero: b.barberName || '',
    codigo: b.code,
    sitio: siteUrl,
  };
  return cfg.reminders.template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function siteUrlFrom(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${host.startsWith('localhost') ? 'http' : 'https'}://${host}` : '';
}

// Lo que el bot tiene que mandar ahora.
export async function outbox(cfg, req, connected) {
  if (!connected) return [];
  if (!cfg.reminders.enabled) return [];
  const now = nowLocal(cfg.timezone);
  if (now.minutes >= QUIET_FROM || now.minutes < QUIET_TO) return [];

  const windowMin = cfg.reminders.hoursBefore * 60;
  const span = Math.ceil(windowMin / 1440) + 1;
  const dates = Array.from({ length: span }, (_, i) => addDays(now.date, i));
  const days = await getDays(dates);
  const siteUrl = siteUrlFrom(req);
  const out = [];

  for (const { date, entries } of days) {
    for (const [field, b] of Object.entries(entries)) {
      if (b.blocked || b.status !== 'confirmado' || !b.phone) continue;
      const r = b.reminder;
      if (r && (r.status !== 'retry' || (r.attempts || 0) >= MAX_ATTEMPTS)) continue;
      const until = minutesBetween(now, { date, minutes: toMin(b.time) });
      if (until < 15 || until > windowMin) continue;
      // Si reservó cuando ya estaba dentro de la ventana, no hace falta recordarle.
      if (b.createdAt) {
        const created = nowLocal(cfg.timezone, new Date(b.createdAt));
        if (minutesBetween(created, { date, minutes: toMin(b.time) }) <= windowMin + 30) continue;
      }
      out.push({
        key: `${date}|${field}`,
        phone: whatsappNumber(b.phone, cfg.reminders.prefix),
        text: renderTemplate(cfg, b, now, siteUrl),
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// El bot avisa qué salió y qué no.
export async function markResults(results) {
  if (!Array.isArray(results)) return 0;
  let n = 0;
  for (const r of results.slice(0, 50)) {
    if (!r || r.transient) continue; // problema de conexión: se reintenta sin gastar intentos
    const key = String(r && r.key || '');
    const i = key.indexOf('|');
    const date = key.slice(0, i);
    const field = key.slice(i + 1);
    if (i < 0 || !isValidDate(date)) continue;
    const raw = await redis('HGET', KEYS.day(date), field);
    if (!raw) continue;
    const b = JSON.parse(raw);
    const attempts = ((b.reminder && b.reminder.attempts) || 0) + 1;
    b.reminder = r.ok
      ? { status: 'sent', at: new Date().toISOString(), attempts }
      : { status: r.retry && attempts < MAX_ATTEMPTS ? 'retry' : 'failed', at: new Date().toISOString(), attempts, error: String(r.error || '').slice(0, 120) };
    await redis('HSET', KEYS.day(date), field, JSON.stringify(b));
    n++;
  }
  return n;
}

