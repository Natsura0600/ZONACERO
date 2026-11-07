import crypto from 'node:crypto';
import { redis, getJSON, setJSON } from './db.js';
import { KEYS, HttpError } from './core.js';

const TOKEN_DAYS = 30;

async function getSecret() {
  let s = await redis('GET', KEYS.secret);
  if (!s) {
    await redis('SET', KEYS.secret, crypto.randomBytes(32).toString('hex'), 'NX');
    s = await redis('GET', KEYS.secret);
  }
  return s;
}

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

export async function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload, await getSecret())}`;
}

export async function requireAdmin(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new HttpError(401, 'Tenés que iniciar sesión.');
  const expected = Buffer.from(sign(payload, await getSecret()));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new HttpError(401, 'Tu sesión venció. Volvé a entrar.');
  }
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { data = null; }
  if (!data || !(data.exp > Date.now())) throw new HttpError(401, 'Tu sesión venció. Volvé a entrar.');
}

export async function hasPassword() {
  return Boolean((await getJSON(KEYS.pass)) || process.env.ADMIN_PASSWORD);
}

export async function verifyPassword(pw) {
  pw = String(pw || '');
  const rec = await getJSON(KEYS.pass);
  if (rec && rec.salt && rec.hash) {
    const h = crypto.scryptSync(pw, rec.salt, 32);
    const stored = Buffer.from(rec.hash, 'hex');
    return stored.length === h.length && crypto.timingSafeEqual(h, stored);
  }
  const env = process.env.ADMIN_PASSWORD;
  if (env) {
    const a = crypto.createHash('sha256').update(pw).digest();
    const b = crypto.createHash('sha256').update(env).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

function hashRecord(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex'), updatedAt: new Date().toISOString() };
}

export function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'La contraseña tiene que tener al menos 6 caracteres.');
  if (pw.length > 200) throw new HttpError(400, 'La contraseña es demasiado larga.');
}

// Primera vez: guarda la contraseña solo si todavía no hay ninguna.
export async function setupPassword(pw) {
  checkNewPassword(pw);
  if (process.env.ADMIN_PASSWORD) throw new HttpError(409, 'La contraseña ya está configurada.');
  const ok = await redis('SET', KEYS.pass, JSON.stringify(hashRecord(pw)), 'NX');
  if (!ok) throw new HttpError(409, 'La contraseña ya está configurada.');
}

export async function changePassword(pw) {
  checkNewPassword(pw);
  await setJSON(KEYS.pass, hashRecord(pw));
  // Rotar el secreto cierra las sesiones abiertas en otros dispositivos.
  await redis('SET', KEYS.secret, crypto.randomBytes(32).toString('hex'));
}

export async function loginGuard(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  const key = KEYS.fail(ip);
  return {
    async check() {
      const n = Number(await redis('GET', key)) || 0;
      if (n >= 8) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.');
    },
    async fail() {
      const n = await redis('INCR', key);
      if (Number(n) === 1) await redis('EXPIRE', key, 900);
    },
    async clear() { await redis('DEL', key); },
  };
}
