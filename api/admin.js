import {
  wrap, send, readBody, HttpError, getConfig, saveConfig, slotsForDate, getDays, isValidDate,
  addDays, weekday, createBooking, normPhone, getClient, saveClient, newClient, clean, clampInt,
  KEYS, genId, nowLocal,
} from './_lib/core.js';
import { redis, pipe, dbReady } from './_lib/db.js';
import {
  notify, vapidPublicKey, saveSubscription, removeSubscription, listDevices, removeDevice,
} from './_lib/notify.js';
import {
  requireAdmin, hasPassword, verifyPassword, setupPassword, changePassword, makeToken, loginGuard,
} from './_lib/auth.js';
import { renderTemplate, runReminders, lastRun, cronSecretSet } from './_lib/reminders.js';
import { linkStatus, startLink, unlink, sendMessages } from './_lib/wa.js';
import { listGallery, addPhoto, saveGallery, deletePhoto } from './_lib/gallery.js';

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

    case 'waStatus': {
      const sample = { name: 'Juan Pérez', time: '10:30', serviceName: (cfg.services[0] || {}).name || 'Corte', barberName: (cfg.barbers[0] || {}).name, code: 'K7P2', date: addDays(nowLocal(cfg.timezone).date, 1) };
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const draft = body.reminders ? { ...cfg, reminders: { ...cfg.reminders, template: clean(body.reminders.template, 600) || cfg.reminders.template } } : cfg;
      return send(res, 200, {
        link: await linkStatus(),
        cron: { secretSet: cronSecretSet(), lastRun: await lastRun() },
        preview: renderTemplate(draft, sample, nowLocal(cfg.timezone), host ? `https://${host}` : ''),
      });
    }

    case 'waLink': {
      const number = body.number ? String(body.number).replace(/\D/g, '') : '';
      if (body.number && (number.length < 10 || number.length > 15)) throw new HttpError(400, 'Escribí el número completo con código de país, por ejemplo 5491123456789.');
      return send(res, 200, { link: await startLink({ pairNumber: number || undefined }) });
    }

    case 'waUnlink':
      await unlink();
      return send(res, 200, { link: await linkStatus() });

    case 'waTest': {
      const phone = normPhone(body.phone);
      if (!phone) throw new HttpError(400, 'Revisá el número.');
      const to = phone.length >= 11 ? phone : (cfg.reminders.prefix || '') + phone;
      const [r] = await sendMessages([{ key: 'test', phone: to, text: `Mensaje de prueba de ${cfg.business.name}: los recordatorios por WhatsApp funcionan.` }]);
      if (!r.ok) throw new HttpError(502, `No se pudo enviar: ${r.error}.`);
      return send(res, 200, { ok: true });
    }

    case 'waRunNow':
      return send(res, 200, { run: await runReminders(cfg, req, { source: 'panel' }) });

    case 'gallery':
      return send(res, 200, { gallery: await listGallery() });

    case 'galleryAdd':
      return send(res, 200, { item: await addPhoto(body) });

    case 'gallerySave':
      return send(res, 200, { gallery: await saveGallery(body.items) });

    case 'galleryDelete':
      return send(res, 200, { gallery: await deletePhoto(body.id) });

    case 'pushKey':
      return send(res, 200, { publicKey: await vapidPublicKey(), devices: await listDevices() });

    case 'pushSubscribe': {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const subject = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : 'mailto:avisos@zonacero.app';
      try { await saveSubscription(body.subscription, { device: clean(body.device, 60), subject }); } catch (e) { throw new HttpError(400, e.message); }
      return send(res, 200, { devices: await listDevices() });
    }

    case 'pushUnsubscribe':
      if (body.id) await removeDevice(body.id); else await removeSubscription(body.endpoint);
      return send(res, 200, { devices: await listDevices() });

    case 'testNotify': {
      const r = await notify('Prueba de avisos', `Si ves esto, los avisos de ${cfg.business.name} funcionan.`);
      if (!r.devices) throw new HttpError(400, 'Todavía no activaste los avisos en ningún celular.');
      if (!r.ok) throw new HttpError(502, 'No se pudo enviar el aviso. Desactivá y volvé a activar los avisos en tu celular.');
      return send(res, 200, r);
    }

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

