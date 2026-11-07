import {
  wrap, send, readBody, HttpError, getConfig, saveConfig, slotsForDate, getDays, isValidDate,
  addDays, weekday, createBooking, normPhone, getClient, saveClient, newClient, clean, clampInt,
  KEYS, genId, nowLocal,
} from './_lib/core.js';
import { redis, pipe, dbReady } from './_lib/db.js';
import {
  requireAdmin, hasPassword, verifyPassword, setupPassword, changePassword, makeToken, loginGuard,
} from './_lib/auth.js';

const STATUSES = ['confirmado', 'atendido', 'ausente'];

async function listClients() {
  const phones = await redis('SMEMBERS', KEYS.clients);
  if (!phones || !phones.length) return [];
  const raws = await pipe(phones.map((p) => ['GET', KEYS.client(p)]));
  const out = [];
  raws.forEach((raw) => {
    if (!raw) return;
    try {
      const c = JSON.parse(raw);
      out.push({
        phone: c.phone, phoneRaw: c.phoneRaw, name: c.name, stamps: c.stamps || 0, visits: c.visits || 0,
        rewards: c.rewards || 0, notes: c.notes || '', createdAt: c.createdAt, lastVisit: c.lastVisit,
      });
    } catch { /* ignorar */ }
  });
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
}

async function mustClient(phone) {
  const p = normPhone(phone);
  const c = p && (await getClient(p));
  if (!c) throw new HttpError(404, 'No encontré ese cliente.');
  return c;
}

function adjustStamps(client, delta) {
  client.stamps = Math.max(0, (client.stamps || 0) + delta);
  client.visits = Math.max(0, (client.visits || 0) + delta);
}

export default wrap(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido.');
  const body = await readBody(req);
  const action = body.action;

  // ----- sin sesión -----
  if (action === 'status') {
    if (!dbReady()) return send(res, 200, { dbReady: false, needsSetup: false });
    return send(res, 200, { dbReady: true, needsSetup: !(await hasPassword()) });
  }
  if (action === 'setup') {
    if (await hasPassword()) throw new HttpError(409, 'La contraseña ya está configurada. Iniciá sesión.');
    await setupPassword(body.password);
    return send(res, 200, { token: await makeToken() });
  }
  if (action === 'login') {
    const guard = await loginGuard(req);
    await guard.check();
    if (!(await verifyPassword(body.password))) {
      await guard.fail();
      throw new HttpError(401, 'Contraseña incorrecta.');
    }
    await guard.clear();
    return send(res, 200, { token: await makeToken() });
  }

  // ----- con sesión -----
  await requireAdmin(req);
  const cfg = await getConfig();

  switch (action) {
    case 'getConfig':
      return send(res, 200, { config: cfg, today: nowLocal(cfg.timezone).date });

    case 'saveConfig':
      return send(res, 200, { config: await saveConfig(body.config) });

    case 'range': {
      const from = isValidDate(body.from) ? body.from : nowLocal(cfg.timezone).date;
      const n = clampInt(body.days, 1, 31, 7);
      const dates = Array.from({ length: n }, (_, i) => addDays(from, i));
      const days = await getDays(dates);
      const now = nowLocal(cfg.timezone);
      return send(res, 200, {
        today: now.date,
        nowMinutes: now.minutes,
        days: days.map(({ date, entries }) => ({
          date,
          closedByDate: cfg.closedDates.includes(date),
          closedByWeek: !(cfg.schedule.week[weekday(date)] || []).length,
          slots: slotsForDate(cfg, date),
          entries: Object.entries(entries).map(([field, e]) => ({ field, ...e })),
        })),
      });
    }

    case 'addBooking': {
      const { booking, field } = await createBooking(cfg, body, { admin: true });
      return send(res, 200, { booking: { field, ...booking } });
    }

    case 'block': {
      if (!isValidDate(body.date) || !/^\d\d:\d\d$/.test(String(body.time || ''))) throw new HttpError(400, 'Horario inválido.');
      const barber = cfg.barbers.find((b) => b.id === body.barberId);
      if (!barber) throw new HttpError(400, 'Barbero inválido.');
      const field = `${body.time}|${barber.id}`;
      const ok = await redis('HSETNX', KEYS.day(body.date), field, JSON.stringify({
        id: genId('x'), blocked: true, date: body.date, time: body.time, barberId: barber.id, barberName: barber.name,
      }));
      if (Number(ok) !== 1) throw new HttpError(409, 'Ese horario ya está ocupado.');
      return send(res, 200, { ok: true });
    }

    case 'setStatus':
    case 'remove': {
      if (!isValidDate(body.date) || typeof body.field !== 'string') throw new HttpError(400, 'Turno inválido.');
      const key = KEYS.day(body.date);
      const raw = await redis('HGET', key, body.field);
      if (!raw) throw new HttpError(404, 'Ese turno ya no existe. Actualizá la agenda.');
      const entry = JSON.parse(raw);

      if (action === 'remove') {
        await redis('HDEL', key, body.field);
        if (!entry.blocked && entry.phone) {
          const client = await getClient(entry.phone);
          if (client) {
            if (entry.status === 'atendido') adjustStamps(client, -1);
            client.refs = (client.refs || []).filter((r) => r !== `${body.date}|${body.field}`);
            await saveClient(client);
          }
        }
        return send(res, 200, { ok: true });
      }

      if (entry.blocked) throw new HttpError(400, 'Ese horario está bloqueado.');
      const status = String(body.status);
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido.');
      const prev = entry.status;
      if (prev === status) return send(res, 200, { entry: { field: body.field, ...entry } });
      entry.status = status;
      await redis('HSET', key, body.field, JSON.stringify(entry));

      let client = await getClient(entry.phone);
      if (!client) client = newClient(entry.phone, entry.phoneRaw, entry.name);
      if (prev !== 'atendido' && status === 'atendido') {
        adjustStamps(client, +1);
        client.lastVisit = entry.date;
      } else if (prev === 'atendido' && status !== 'atendido') {
        adjustStamps(client, -1);
      }
      await saveClient(client);
      return send(res, 200, { entry: { field: body.field, ...entry } });
    }

    case 'toggleDay': {
      if (!isValidDate(body.date)) throw new HttpError(400, 'Fecha inválida.');
      const set = new Set(cfg.closedDates);
      if (set.has(body.date)) set.delete(body.date); else set.add(body.date);
      const saved = await saveConfig({ ...cfg, closedDates: [...set] });
      return send(res, 200, { config: saved });
    }

    case 'clients':
      return send(res, 200, { clients: await listClients() });

    case 'addClient': {
      const phone = normPhone(body.phone);
      if (!phone) throw new HttpError(400, 'Revisá el teléfono: entre 8 y 13 números, con característica.');
      const name = clean(body.name, 60);
      if (name.length < 2) throw new HttpError(400, 'Escribí el nombre.');
      if (await getClient(phone)) throw new HttpError(409, 'Ya hay un cliente con ese teléfono.');
      const c = newClient(phone, body.phone, name);
      c.stamps = c.visits = clampInt(body.stamps, 0, 999, 0);
      await saveClient(c);
      return send(res, 200, { ok: true });
    }

    case 'updateClient': {
      const c = await mustClient(body.phone);
      if (body.name !== undefined) {
        const name = clean(body.name, 60);
        if (name.length < 2) throw new HttpError(400, 'Escribí el nombre.');
        c.name = name;
      }
      if (body.notes !== undefined) c.notes = clean(body.notes, 500);
      if (body.stamps !== undefined) c.stamps = clampInt(body.stamps, 0, 999, c.stamps);
      await saveClient(c);
      return send(res, 200, { ok: true });
    }

    case 'stamp': {
      const c = await mustClient(body.phone);
      const delta = Number(body.delta) > 0 ? 1 : -1;
      adjustStamps(c, delta);
      if (delta > 0) c.lastVisit = nowLocal(cfg.timezone).date;
      await saveClient(c);
      return send(res, 200, { ok: true, stamps: c.stamps });
    }

    case 'redeem': {
      const c = await mustClient(body.phone);
      if ((c.stamps || 0) < cfg.loyalty.goal) throw new HttpError(400, `Le faltan ${cfg.loyalty.goal - (c.stamps || 0)} sellos para el premio.`);
      c.stamps -= cfg.loyalty.goal;
      c.rewards = (c.rewards || 0) + 1;
      await saveClient(c);
      return send(res, 200, { ok: true, stamps: c.stamps });
    }

    case 'deleteClient': {
      const c = await mustClient(body.phone);
      await pipe([['DEL', KEYS.client(c.phone)], ['SREM', KEYS.clients, c.phone]]);
      return send(res, 200, { ok: true });
    }

    case 'changePassword': {
      if (!(await verifyPassword(body.current))) throw new HttpError(401, 'La contraseña actual no es correcta.');
      await changePassword(body.next);
      return send(res, 200, { token: await makeToken() });
    }

    default:
      throw new HttpError(400, 'Acción desconocida.');
  }
});

