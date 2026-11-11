// Mensajes de "reclamá tu beneficio": se mandan por WhatsApp cuando alguien saca el turno
// que cae en el corte 5 (50% off) o en el 10 (gratis) de su tarjeta.
// Se guardan en una cola y se mandan enseguida; si WhatsApp no está disponible en ese momento,
// los levanta la próxima revisión automática (cron).

import { redis, pairsToObject } from './db.js';
import { KEYS, nowLocal } from './core.js';
import { describeWhen } from './reminders.js';

const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 24 * 3600 * 1000; // un aviso de más de un día ya no sirve

const lower = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

export function claimText(cfg, booking, benefit) {
  const when = describeWhen(booking.date, nowLocal(cfg.timezone).date);
  const vars = {
    nombre: String(booking.name || '').split(' ')[0],
    barberia: cfg.business.name,
    cuando: when.cuando,
    dia: when.dia,
    hora: booking.time,
    servicio: booking.serviceName,
    codigo: booking.code,
    numero: String(benefit.number),
    beneficio: `tenés ${lower(benefit.label)}`,
  };
  return cfg.loyalty.claimTemplate.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export async function enqueueClaim(cfg, booking, benefit) {
  const phone = booking.phone.length >= 11 ? booking.phone : (cfg.reminders.prefix || '') + booking.phone;
  await redis('HSET', KEYS.claimq, booking.id, JSON.stringify({
    phone, text: claimText(cfg, booking, benefit), attempts: 0, at: new Date().toISOString(),
  }));
}

// Manda lo que haya en la cola. Nunca tira error.
export async function flushClaims() {
  let all;
  try { all = pairsToObject(await redis('HGETALL', KEYS.claimq)); } catch { return { sent: 0, pending: 0 }; }
  const ids = Object.keys(all);
  if (!ids.length) return { sent: 0, pending: 0 };

  const items = [];
  for (const id of ids) {
    let it;
    try { it = JSON.parse(all[id]); } catch { it = null; }
    if (!it || Date.now() - new Date(it.at).getTime() > MAX_AGE_MS || (it.attempts || 0) >= MAX_ATTEMPTS) {
      await redis('HDEL', KEYS.claimq, id).catch(() => {});
      continue;
    }
    items.push({ id, ...it });
  }
  if (!items.length) return { sent: 0, pending: 0 };

  const { sendMessages, linkStatus } = await import('./wa.js');
  if (!(await linkStatus()).linked) return { sent: 0, pending: items.length };

  const results = await sendMessages(items.slice(0, 10).map((it) => ({ key: it.id, phone: it.phone, text: it.text })));
  let sent = 0;
  for (const r of results) {
    const it = items.find((x) => x.id === r.key);
    if (r.ok) { sent++; await redis('HDEL', KEYS.claimq, r.key); continue; }
    if (r.transient) continue; // problema de conexión: se reintenta sin gastar intentos
    if (!r.retry) { await redis('HDEL', KEYS.claimq, r.key); continue; } // ej. el número no tiene WhatsApp
    await redis('HSET', KEYS.claimq, r.key, JSON.stringify({ phone: it.phone, text: it.text, at: it.at, attempts: (it.attempts || 0) + 1 }));
  }
  return { sent, pending: items.length - sent };
}
