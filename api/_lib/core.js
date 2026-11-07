import crypto from 'node:crypto';
import { redis, pipe, getJSON, setJSON, pairsToObject, DbMissingError } from './db.js';

export const KEYS = {
  config: 'zc:config',
  day: (d) => `zc:day:${d}`,
  client: (p) => `zc:client:${p}`,
  clients: 'zc:clients',
  pass: 'zc:admin:pass',
  secret: 'zc:admin:secret',
  fail: (ip) => `zc:fail:${ip}`,
};

export const DEFAULT_CONFIG = {
  business: {
    name: 'Zona Cero',
    tagline: 'Barbería',
    heroTitle: 'Tu corte, a tu hora.',
    heroText: 'Fade, tijera, barba o rapado al cero. Elegí el horario que te quede cómodo y sumá un sello cada vez que venís.',
    about: '',
    announcement: '',
    instagram: '',
    whatsapp: '',
  },
  theme: { accent: '#d8382c' },
  services: [
    { id: 'corte', name: 'Corte', desc: 'Máquina y tijera, lavado y peinado.', price: 12000, active: true },
    { id: 'cortebarba', name: 'Corte + barba', desc: 'Corte completo y perfilado de barba con navaja.', price: 16000, active: true },
    { id: 'barba', name: 'Barba', desc: 'Perfilado, toalla caliente y aceite.', price: 7000, active: true },
    { id: 'cero', name: 'Rapado al cero', desc: 'Máquina sin peine y terminación con navaja.', price: 9000, active: true },
  ],
  barbers: [{ id: 'b1', name: 'Barbero', active: true }],
  schedule: {
    slotMinutes: 30,
    daysAhead: 14,
    minNoticeMinutes: 60,
    maxActivePerClient: 2,
    week: {
      0: [],
      1: [],
      2: [{ from: '10:00', to: '20:00' }],
      3: [{ from: '10:00', to: '20:00' }],
      4: [{ from: '10:00', to: '20:00' }],
      5: [{ from: '10:00', to: '20:00' }],
      6: [{ from: '10:00', to: '18:00' }],
    },
  },
  closedDates: [],
  loyalty: {
    enabled: true,
    goal: 10,
    reward: 'Corte gratis',
    text: 'Cada visita suma un sello. Cuando completás la tarjeta, el próximo corte va por la casa.',
  },
  timezone: 'America/Argentina/Buenos_Aires',
};

// ---------- errores y respuestas ----------
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export async function readBody(req) {
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    try { return JSON.parse(body); } catch { throw new HttpError(400, 'Solicitud inválida.'); }
  }
  return body && typeof body === 'object' ? body : {};
}

export function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const url = new URL(req.url || '/', 'http://x');
  return Object.fromEntries(url.searchParams);
}

export function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof DbMissingError) return send(res, 503, { error: err.message, code: 'db_missing' });
      console.error(err);
      return send(res, 500, { error: 'Algo falló del lado del servidor. Probá de nuevo en un rato.' });
    }
  };
}

// ---------- utilidades ----------
export function clean(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function clampInt(v, min, max, def = min) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function normPhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length < 8 || d.length > 13) return '';
  return d;
}

export function genId(prefix = '') {
  return prefix + crypto.randomBytes(5).toString('hex');
}

export function genCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(4);
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

const validId = (id) => (typeof id === 'string' && /^[a-z0-9_-]{1,24}$/i.test(id) ? id : '');

// ---------- fechas (siempre en hora local del negocio) ----------
export const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function nowLocal(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return nowLocal(DEFAULT_CONFIG.timezone);
  }
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// ---------- configuración ----------
export function normalizeConfig(c) {
  c = c && typeof c === 'object' ? c : {};
  const d = DEFAULT_CONFIG;
  const sch = c.schedule && typeof c.schedule === 'object' ? c.schedule : {};
  return {
    business: { ...d.business, ...(c.business || {}) },
    theme: { ...d.theme, ...(c.theme || {}) },
    services: Array.isArray(c.services) ? c.services : d.services,
    barbers: Array.isArray(c.barbers) && c.barbers.length ? c.barbers : d.barbers,
    schedule: { ...d.schedule, ...sch, week: { ...d.schedule.week, ...(sch.week || {}) } },
    closedDates: Array.isArray(c.closedDates) ? c.closedDates : [],
    loyalty: { ...d.loyalty, ...(c.loyalty || {}) },
    timezone: c.timezone || d.timezone,
  };
}

export function sanitizeConfig(input) {
  const c = normalizeConfig(input);
  const b = c.business;
  const ids = new Set();
  const uniqueId = (id, prefix) => {
    let v = validId(id) || genId(prefix);
    while (ids.has(v)) v = genId(prefix);
    ids.add(v);
    return v;
  };

  const services = c.services.slice(0, 40)
    .map((s) => ({
      id: uniqueId(s && s.id, 's'),
      name: clean(s && s.name, 60),
      desc: clean(s && s.desc, 200),
      price: clampInt(s && s.price, 0, 100000000, 0),
      active: !(s && s.active === false),
    }))
    .filter((s) => s.name);

  let barbers = c.barbers.slice(0, 12)
    .map((x) => ({ id: uniqueId(x && x.id, 'b'), name: clean(x && x.name, 40), active: !(x && x.active === false) }))
    .filter((x) => x.name);
  if (!barbers.length) barbers = [{ id: 'b1', name: 'Barbero', active: true }];

  const week = {};
  for (let i = 0; i < 7; i++) {
    const ranges = Array.isArray(c.schedule.week[i]) ? c.schedule.week[i] : [];
    week[i] = ranges
      .filter((r) => r && isTime(r.from) && isTime(r.to) && toMin(r.from) < toMin(r.to))
      .slice(0, 3)
      .map((r) => ({ from: r.from, to: r.to }));
  }

  const slotOptions = [10, 15, 20, 30, 40, 45, 60, 75, 90, 120];
  const slot = Number(c.schedule.slotMinutes);
  const accent = String(c.theme.accent || '');

  return {
    business: {
      name: clean(b.name, 40) || 'Zona Cero',
      tagline: clean(b.tagline, 60),
      heroTitle: clean(b.heroTitle, 90),
      heroText: clean(b.heroText, 320),
      about: clean(b.about, 900),
      announcement: clean(b.announcement, 140),
      instagram: clean(b.instagram, 60).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, ''),
      whatsapp: clean(b.whatsapp, 24),
    },
    theme: { accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_CONFIG.theme.accent },
    services,
    barbers,
    schedule: {
      slotMinutes: slotOptions.includes(slot) ? slot : 30,
      daysAhead: clampInt(c.schedule.daysAhead, 1, 90, 14),
      minNoticeMinutes: clampInt(c.schedule.minNoticeMinutes, 0, 2880, 60),
      maxActivePerClient: clampInt(c.schedule.maxActivePerClient, 1, 10, 2),
      week,
    },
    closedDates: [...new Set(c.closedDates.filter(isValidDate))].sort().slice(-300),
    loyalty: {
      enabled: c.loyalty.enabled !== false,
      goal: clampInt(c.loyalty.goal, 2, 30, 10),
      reward: clean(c.loyalty.reward, 60) || 'Corte gratis',
      text: clean(c.loyalty.text, 320),
    },
    timezone: validTz(c.timezone) ? c.timezone : DEFAULT_CONFIG.timezone,
  };
}

export async function getConfig() {
  return normalizeConfig(await getJSON(KEYS.config));
}

export async function saveConfig(input) {
  const cfg = sanitizeConfig(input);
  await setJSON(KEYS.config, cfg);
  return cfg;
}

// ---------- agenda ----------
export function slotsForDate(cfg, date) {
  if (cfg.closedDates.includes(date)) return [];
  const ranges = cfg.schedule.week[weekday(date)] || [];
  const step = Number(cfg.schedule.slotMinutes) || 30;
  const out = new Set();
  for (const r of ranges) {
    if (!isTime(r.from) || !isTime(r.to)) continue;
    for (let t = toMin(r.from); t + step <= toMin(r.to); t += step) out.add(fromMin(t));
  }
  return [...out].sort();
}

export function publicSlots(cfg, date, now = nowLocal(cfg.timezone)) {
  const last = addDays(now.date, cfg.schedule.daysAhead - 1);
  if (date < now.date || date > last) return [];
  let slots = slotsForDate(cfg, date);
  if (date === now.date) slots = slots.filter((t) => toMin(t) >= now.minutes + cfg.schedule.minNoticeMinutes);
  return slots;
}

export function publicDays(cfg) {
  const now = nowLocal(cfg.timezone);
  const days = [];
  for (let i = 0; i < cfg.schedule.daysAhead; i++) {
    const date = addDays(now.date, i);
    days.push({ date, open: publicSlots(cfg, date, now).length > 0 });
  }
  return { today: now.date, days };
}

export async function getDay(date) {
  const raw = pairsToObject(await redis('HGETALL', KEYS.day(date)));
  const out = {};
  for (const [field, v] of Object.entries(raw)) {
    try { out[field] = JSON.parse(v); } catch { /* ignorar */ }
  }
  return out;
}

export async function getDays(dates) {
  const results = await pipe(dates.map((d) => ['HGETALL', KEYS.day(d)]));
  return dates.map((date, i) => {
    const raw = pairsToObject(results[i]);
    const entries = {};
    for (const [field, v] of Object.entries(raw)) {
      try { entries[field] = JSON.parse(v); } catch { /* ignorar */ }
    }
    return { date, entries };
  });
}

// ---------- clientes ----------
export function newClient(phone, phoneRaw, name) {
  return {
    phone, phoneRaw: clean(phoneRaw, 30) || phone, name: clean(name, 60),
    stamps: 0, visits: 0, rewards: 0, notes: '', refs: [],
    createdAt: new Date().toISOString(), lastVisit: null,
  };
}

export async function getClient(phone) {
  return getJSON(KEYS.client(phone));
}

export async function saveClient(client) {
  await pipe([
    ['SET', KEYS.client(client.phone), JSON.stringify(client)],
    ['SADD', KEYS.clients, client.phone],
  ]);
}

export async function clientBookings(client) {
  const refs = Array.isArray(client.refs) ? client.refs : [];
  if (!refs.length) return [];
  const cmds = refs.map((ref) => {
    const i = ref.indexOf('|');
    return ['HGET', KEYS.day(ref.slice(0, i)), ref.slice(i + 1)];
  });
  const results = await pipe(cmds);
  const out = [];
  results.forEach((raw, i) => {
    if (!raw) return;
    try {
      const b = JSON.parse(raw);
      if (b && !b.blocked && b.phone === client.phone) out.push({ ...b, ref: refs[i] });
    } catch { /* ignorar */ }
  });
  return out;
}

export function isUpcoming(b, now) {
  return b.status === 'confirmado' && (b.date > now.date || (b.date === now.date && toMin(b.time) >= now.minutes));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function createBooking(cfg, input, { admin = false } = {}) {
  const name = clean(input.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Escribí tu nombre.');
  const phone = normPhone(input.phone);
  if (!phone) throw new HttpError(400, 'Revisá el teléfono: tiene que tener entre 8 y 13 números, con característica.');
  const service = cfg.services.find((s) => s.id === input.serviceId && (admin || s.active));
  if (!service) throw new HttpError(400, 'Elegí un servicio.');
  const date = String(input.date || '');
  const time = String(input.time || '');
  if (!isValidDate(date)) throw new HttpError(400, 'Elegí un día.');

  const now = nowLocal(cfg.timezone);
  const allowed = admin ? slotsForDate(cfg, date) : publicSlots(cfg, date, now);
  if (!allowed.includes(time)) throw new HttpError(400, 'Ese horario ya no está disponible. Elegí otro.');

  let candidates;
  if (!input.barberId || input.barberId === 'any') {
    candidates = shuffle(cfg.barbers.filter((b) => b.active));
  } else {
    const b = cfg.barbers.find((x) => x.id === input.barberId && (admin || x.active));
    if (!b) throw new HttpError(400, 'Elegí un barbero.');
    candidates = [b];
  }
  if (!candidates.length) throw new HttpError(400, 'No hay barberos disponibles.');

  let client = await getClient(phone);
  if (!admin && client) {
    const active = (await clientBookings(client)).filter((b) => isUpcoming(b, now));
    if (active.length >= cfg.schedule.maxActivePerClient) {
      throw new HttpError(409, `Ya tenés ${active.length === 1 ? 'un turno reservado' : active.length + ' turnos reservados'}. Cancelá uno desde "Mi tarjeta" para sacar otro.`);
    }
  }

  const booking = {
    id: genId('t'), code: genCode(), date, time,
    serviceId: service.id, serviceName: service.name, price: service.price,
    name, phone, phoneRaw: clean(input.phone, 30),
    status: 'confirmado', source: admin ? 'panel' : 'web', createdAt: new Date().toISOString(),
  };

  for (const b of candidates) {
    const field = `${time}|${b.id}`;
    booking.barberId = b.id;
    booking.barberName = b.name;
    const ok = await redis('HSETNX', KEYS.day(date), field, JSON.stringify(booking));
    if (Number(ok) === 1) {
      client = client || newClient(phone, input.phone, name);
      client.name = name;
      const ref = `${date}|${field}`;
      client.refs = [...(client.refs || []).filter((r) => r !== ref), ref].slice(-40);
      await saveClient(client);
      return { booking, field };
    }
  }
  throw new HttpError(409, 'Ese horario se acaba de ocupar. Elegí otro.');
}

export async function removeRef(phone, ref) {
  const client = await getClient(phone);
  if (!client) return;
  client.refs = (client.refs || []).filter((r) => r !== ref);
  await saveClient(client);
}
