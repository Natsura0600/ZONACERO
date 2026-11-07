// Notificaciones push al celular del dueño (Web Push con claves VAPID).
// Las claves se generan solas la primera vez y quedan guardadas en la base.
// Si preferís fijarlas vos, definí VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en Vercel.

import crypto from 'node:crypto';
import webpush from 'web-push';
import { redis, getJSON, pairsToObject } from './db.js';

const K = { vapid: 'zc:vapid', subs: 'zc:push' };

async function getVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
  }
  let keys = await getJSON(K.vapid);
  if (!keys) {
    await redis('SET', K.vapid, JSON.stringify(webpush.generateVAPIDKeys()), 'NX');
    keys = await getJSON(K.vapid);
  }
  return keys;
}

export async function vapidPublicKey() {
  return (await getVapid()).publicKey;
}

const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 20);

export async function saveSubscription(sub, { device, subject }) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Suscripción inválida.');
  }
  const record = {
    subscription: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    device: String(device || 'Dispositivo').slice(0, 60),
    subject,
    createdAt: new Date().toISOString(),
  };
  await redis('HSET', K.subs, subId(sub.endpoint), JSON.stringify(record));
}

export async function removeSubscription(endpoint) {
  if (typeof endpoint === 'string') await redis('HDEL', K.subs, subId(endpoint));
}

export async function listDevices() {
  const all = pairsToObject(await redis('HGETALL', K.subs));
  return Object.entries(all).map(([id, raw]) => {
    try { const r = JSON.parse(raw); return { id, device: r.device, createdAt: r.createdAt, endpoint: r.subscription.endpoint }; } catch { return null; }
  }).filter(Boolean);
}

export async function removeDevice(id) {
  await redis('HDEL', K.subs, String(id));
}

// Manda el aviso a todos los dispositivos activados. Nunca tira error.
export async function notify(title, body, { url = '/admin#agenda', tag } = {}) {
  let all;
  let keys;
  try {
    all = pairsToObject(await redis('HGETALL', K.subs));
    if (!Object.keys(all).length) return { ok: 0, failed: 0, devices: 0 };
    keys = await getVapid();
  } catch (e) {
    console.error('Avisos:', e.message);
    return { ok: 0, failed: 0, devices: 0 };
  }
  const payload = JSON.stringify({ title, body, url, tag: tag || 'zc-' + Date.now() });
  let ok = 0;
  let failed = 0;
  await Promise.all(Object.entries(all).map(async ([id, raw]) => {
    try {
      const rec = JSON.parse(raw);
      await webpush.sendNotification(rec.subscription, payload, {
        vapidDetails: { subject: rec.subject || 'mailto:avisos@zonacero.app', publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 6 * 3600,
        urgency: 'high',
        timeout: 5000,
      });
      ok++;
    } catch (e) {
      failed++;
      // 404/410: el celular desactivó los avisos o se venció la suscripción.
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await redis('HDEL', K.subs, id).catch(() => {});
      else console.error('Aviso fallido:', e && (e.statusCode || e.message));
    }
  }));
  return { ok, failed, devices: Object.keys(all).length };
}

export function describeBooking(b) {
  const d = new Date(b.date + 'T12:00:00Z');
  const when = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return `${when} · ${b.time} h`;
}
