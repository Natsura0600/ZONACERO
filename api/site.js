import {
  wrap, send, readBody, getQuery, HttpError, getConfig, publicDays, publicSlots, getDay,
  isValidDate, createBooking, normPhone, getClient, clientBookings, isUpcoming, nowLocal,
  KEYS, removeRef,
} from './_lib/core.js';
import { redis } from './_lib/db.js';
import { notify, describeBooking } from './_lib/notify.js';
import { listGallery, sendPhoto } from './_lib/gallery.js';

function publicConfig(cfg, gallery) {
  return {
    gallery: gallery.map(({ id, caption, w, h }) => ({ id, caption, w, h })),
    business: cfg.business,
    theme: cfg.theme,
    services: cfg.services.filter((s) => s.active).map(({ id, name, desc, price }) => ({ id, name, desc, price })),
    barbers: cfg.barbers.filter((b) => b.active).map(({ id, name }) => ({ id, name })),
    loyalty: cfg.loyalty,
    ...publicDays(cfg),
  };
}

function summary(b) {
  return {
    code: b.code, date: b.date, time: b.time, serviceName: b.serviceName,
    price: b.price, barberName: b.barberName, status: b.status,
  };
}

async function cardFor(cfg, phone) {
  const client = await getClient(phone);
  if (!client) return { client: null, upcoming: [] };
  const now = nowLocal(cfg.timezone);
  const upcoming = (await clientBookings(client))
    .filter((b) => isUpcoming(b, now))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map(summary);
  return {
    client: {
      name: String(client.name || '').split(' ')[0],
      stamps: client.stamps || 0,
      visits: client.visits || 0,
      rewards: client.rewards || 0,
    },
    upcoming,
  };
}

export default wrap(async (req, res) => {
  const q = getQuery(req);
  const body = req.method === 'POST' ? await readBody(req) : {};
  const action = body.action || q.action;
  if (action === 'photo') return sendPhoto(res, q.id);
  const cfg = await getConfig();

  if (action === 'config') return send(res, 200, publicConfig(cfg, await listGallery()));

  if (action === 'slots') {
    const date = String(q.date || body.date || '');
    if (!isValidDate(date)) throw new HttpError(400, 'Fecha inválida.');
    const barberId = String(q.barber || body.barber || 'any');
    const active = cfg.barbers.filter((b) => b.active);
    const targets = barberId === 'any' ? active : active.filter((b) => b.id === barberId);
    const taken = await getDay(date);
    const times = publicSlots(cfg, date).filter((t) => targets.some((b) => !taken[`${t}|${b.id}`]));
    return send(res, 200, { date, times });
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido.');

  if (action === 'book') {
    const { booking } = await createBooking(cfg, body);
    const multi = cfg.barbers.filter((b) => b.active).length > 1;
    await notify(`Nuevo turno: ${booking.name}`, [
      describeBooking(booking),
      `${booking.serviceName}${multi ? ' con ' + booking.barberName : ''}`,
      `Cel: ${booking.phoneRaw || booking.phone}`,
    ].join('\n'));
    const card = cfg.loyalty.enabled ? await cardFor(cfg, booking.phone) : null;
    return send(res, 200, { booking: summary(booking), card });
  }

  if (action === 'lookup') {
    const phone = normPhone(body.phone);
    if (!phone) throw new HttpError(400, 'Revisá el teléfono: tiene que tener entre 8 y 13 números, con característica.');
    return send(res, 200, await cardFor(cfg, phone));
  }

  if (action === 'cancel') {
    const phone = normPhone(body.phone);
    const code = String(body.code || '').trim().toUpperCase();
    if (!phone || !code) throw new HttpError(400, 'Faltan el teléfono o el código del turno.');
    const client = await getClient(phone);
    if (!client) throw new HttpError(404, 'No encontramos turnos con ese teléfono.');
    const now = nowLocal(cfg.timezone);
    const match = (await clientBookings(client)).find((b) => b.code === code && isUpcoming(b, now));
    if (!match) throw new HttpError(404, 'El código no coincide con ningún turno próximo. Revisalo y probá de nuevo.');
    const field = match.ref.slice(match.ref.indexOf('|') + 1);
    await redis('HDEL', KEYS.day(match.date), field);
    await removeRef(phone, match.ref);
    await notify(`Turno cancelado: ${match.name}`, `${describeBooking(match)}\n${match.serviceName}\nEl horario quedó libre.`);
    return send(res, 200, { ok: true, ...(await cardFor(cfg, phone)) });
  }

  throw new HttpError(400, 'Acción desconocida.');
});

