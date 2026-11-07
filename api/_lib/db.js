// Cliente mínimo para Upstash Redis vía REST (sin dependencias).
// En Vercel: Storage → Upstash for Redis → Connect. Eso crea KV_REST_API_URL y KV_REST_API_TOKEN.

const REST_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_MEMORY = process.env.ZC_MEMORY_DB === '1'; // solo para pruebas locales

export class DbMissingError extends Error {
  constructor() {
    super('Falta conectar la base de datos (Upstash Redis).');
    this.code = 'db_missing';
  }
}

export function dbReady() {
  return USE_MEMORY || Boolean(REST_URL && REST_TOKEN);
}

async function rest(path, body) {
  if (!REST_URL || !REST_TOKEN) throw new DbMissingError();
  const res = await fetch(REST_URL + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok && !Array.isArray(data)) {
    throw new Error('Redis: ' + ((data && data.error) || res.status));
  }
  return data;
}

export async function redis(...args) {
  if (USE_MEMORY) return memExec(args);
  const data = await rest('', args.map(String));
  if (data.error) throw new Error('Redis: ' + data.error);
  return data.result;
}

export async function pipe(commands) {
  if (!commands.length) return [];
  if (USE_MEMORY) return commands.map(memExec);
  const data = await rest('/pipeline', commands.map((c) => c.map(String)));
  return data.map((d) => {
    if (d.error) throw new Error('Redis: ' + d.error);
    return d.result;
  });
}

export async function getJSON(key) {
  const raw = await redis('GET', key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setJSON(key, value) {
  return redis('SET', key, JSON.stringify(value));
}

export function pairsToObject(flat) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

// --- Memoria (solo desarrollo local) ---
const store = (globalThis.__zcMemory ||= new Map());

function memExec([command, ...a]) {
  const cmd = String(command).toUpperCase();
  const hash = (k, create) => {
    let h = store.get(k);
    if (!(h instanceof Map)) { if (!create) return null; h = new Map(); store.set(k, h); }
    return h;
  };
  const set = (k, create) => {
    let s = store.get(k);
    if (!(s instanceof Set)) { if (!create) return null; s = new Set(); store.set(k, s); }
    return s;
  };
  switch (cmd) {
    case 'GET': { const v = store.get(a[0]); return typeof v === 'string' ? v : null; }
    case 'SET': {
      const nx = a.slice(2).some((o) => String(o).toUpperCase() === 'NX');
      if (nx && store.has(a[0])) return null;
      store.set(a[0], String(a[1]));
      return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    case 'INCR': { const v = parseInt(store.get(a[0]) || '0', 10) + 1; store.set(a[0], String(v)); return v; }
    case 'EXPIRE': return 1;
    case 'HGETALL': { const h = hash(a[0]); return h ? [...h].flat() : []; }
    case 'HGET': { const h = hash(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
    case 'HSET': {
      const h = hash(a[0], true); let n = 0;
      for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], String(a[i + 1])); }
      return n;
    }
    case 'HSETNX': { const h = hash(a[0], true); if (h.has(a[1])) return 0; h.set(a[1], String(a[2])); return 1; }
    case 'HDEL': {
      const h = hash(a[0]); if (!h) return 0; let n = 0;
      for (const f of a.slice(1)) if (h.delete(f)) n++;
      if (!h.size) store.delete(a[0]);
      return n;
    }
    case 'SADD': { const s = set(a[0], true); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } return n; }
    case 'SREM': { const s = set(a[0]); if (!s) return 0; let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; return n; }
    case 'SMEMBERS': { const s = set(a[0]); return s ? [...s] : []; }
    default: throw new Error('Comando no soportado en memoria: ' + cmd);
  }
}
