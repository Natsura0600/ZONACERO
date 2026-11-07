// Galería de cortes. Las fotos llegan ya achicadas desde el panel y se guardan en la misma base.
import { redis, getJSON, setJSON } from './db.js';
import { KEYS, HttpError, clean, genId, clampInt } from './core.js';

const MAX_PHOTOS = 40;
const MAX_B64 = 950 * 1024; // ~700 KB de imagen
const TYPES = ['image/jpeg', 'image/webp', 'image/png'];

export async function listGallery() {
  const list = await getJSON(KEYS.gallery);
  return Array.isArray(list) ? list : [];
}

export async function addPhoto({ data, caption, w, h }) {
  const m = /^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m || !TYPES.includes(m[1])) throw new HttpError(400, 'El archivo no es una imagen válida.');
  if (m[2].length > MAX_B64) throw new HttpError(413, 'La foto es demasiado pesada. Probá con otra.');
  const list = await listGallery();
  if (list.length >= MAX_PHOTOS) throw new HttpError(409, `La galería admite hasta ${MAX_PHOTOS} fotos. Borrá alguna para subir otra.`);
  const id = genId('f');
  await redis('SET', KEYS.img(id), `${m[1]};${m[2]}`);
  const item = { id, caption: clean(caption, 80), w: clampInt(w, 1, 5000, 1000), h: clampInt(h, 1, 5000, 1000), createdAt: new Date().toISOString() };
  // la foto nueva va primera
  await setJSON(KEYS.gallery, [item, ...list]);
  return item;
}

export async function saveGallery(items) {
  const list = await listGallery();
  if (!Array.isArray(items)) throw new HttpError(400, 'Datos inválidos.');
  const byId = new Map(list.map((x) => [x.id, x]));
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const cur = it && byId.get(it.id);
    if (!cur || seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push({ ...cur, caption: clean(it.caption, 80) });
  }
  for (const x of list) if (!seen.has(x.id)) out.push(x); // nada se pierde por un orden incompleto
  await setJSON(KEYS.gallery, out);
  return out;
}

export async function deletePhoto(id) {
  const list = await listGallery();
  await setJSON(KEYS.gallery, list.filter((x) => x.id !== id));
  await redis('DEL', KEYS.img(String(id)));
  return list.filter((x) => x.id !== id);
}

export async function sendPhoto(res, id) {
  const raw = /^f[0-9a-f]{10}$/.test(String(id)) ? await redis('GET', KEYS.img(id)) : null;
  if (!raw) {
    res.statusCode = 404;
    res.setHeader('Cache-Control', 'no-store');
    res.end('No existe');
    return;
  }
  const i = raw.indexOf(';');
  const buf = Buffer.from(raw.slice(i + 1), 'base64');
  res.statusCode = 200;
  res.setHeader('Content-Type', raw.slice(0, i));
  res.setHeader('Content-Length', buf.length);
  // Cada foto tiene id único: se puede guardar en caché para siempre.
  res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
  res.end(buf);
}
