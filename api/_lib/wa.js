// WhatsApp (Baileys) corriendo dentro de Vercel.
// La sesión se guarda en Upstash, así que se vincula una sola vez escaneando el QR desde el panel.
// Cada envío abre la conexión, manda los mensajes y la cierra.

import makeWASocket, { initAuthCreds, BufferJSON, proto, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { redis, pipe, getJSON, setJSON } from './db.js';

const K = {
  creds: 'zc:wa:creds',
  keys: 'zc:wa:keys',      // hash: "<tipo>-<id>" -> JSON
  link: 'zc:wa:link',      // estado de la vinculación para el panel
  lock: 'zc:wa:lock',      // evita dos conexiones a la vez
};

const silent = { level: 'silent', child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sesión en Upstash ----------
async function redisAuthState() {
  const raw = await redis('GET', K.creds);
  const creds = raw ? JSON.parse(raw, BufferJSON.reviver) : initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          if (!ids.length) return out;
          const vals = await redis('HMGET', K.keys, ...ids.map((id) => `${type}-${id}`));
          ids.forEach((id, i) => {
            let v = vals && vals[i] ? JSON.parse(vals[i], BufferJSON.reviver) : null;
            if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          });
          return out;
        },
        set: async (data) => {
          const cmds = [];
          for (const type in data) {
            for (const id in data[type]) {
              const v = data[type][id];
              cmds.push(v ? ['HSET', K.keys, `${type}-${id}`, JSON.stringify(v, BufferJSON.replacer)] : ['HDEL', K.keys, `${type}-${id}`]);
            }
          }
          if (cmds.length) await pipe(cmds);
        },
      },
    },
    saveCreds: () => redis('SET', K.creds, JSON.stringify(creds, BufferJSON.replacer)),
  };
}

export async function clearSession() {
  await redis('DEL', K.creds, K.keys);
}

async function isRegistered() {
  const raw = await redis('GET', K.creds);
  if (!raw) return false;
  try { return Boolean(JSON.parse(raw, BufferJSON.reviver).registered || JSON.parse(raw).me); } catch { return false; }
}

async function setLink(patch) {
  const cur = (await getJSON(K.link)) || {};
  const next = { ...cur, ...patch, at: new Date().toISOString() };
  await setJSON(K.link, next);
  return next;
}

export async function linkStatus() {
  const link = (await getJSON(K.link)) || {};
  const registered = await isRegistered();
  return {
    linked: registered && link.state !== 'logged_out',
    number: link.number || '',
    state: link.state || (registered ? 'linked' : 'none'),
    qr: link.state === 'waiting' ? link.qr || '' : '',
    pairingCode: link.state === 'waiting' ? link.pairingCode || '' : '',
    error: link.error || '',
    at: link.at || null,
    lastSend: link.lastSend || null,
  };
}

async function lock(seconds) {
  const ok = await redis('SET', K.lock, String(Date.now()), 'NX', 'EX', seconds);
  return Boolean(ok);
}
const unlock = () => redis('DEL', K.lock);

let cachedVersion;
async function waVersion() {
  if (!cachedVersion) cachedVersion = (await fetchLatestBaileysVersion().catch(() => ({}))).version;
  return cachedVersion;
}

// Abre un socket y resuelve cuando conecta. onQr recibe cada QR nuevo.
async function openSocket({ onQr, pairNumber, timeoutMs }) {
  const { state, saveCreds } = await redisAuthState();
  const sock = makeWASocket({
    auth: state,
    version: await waVersion(),
    logger: silent,
    browser: Browsers.macOS('Zona Cero'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });
  let credsWrite = Promise.resolve();
  sock.ev.on('creds.update', () => { credsWrite = credsWrite.then(saveCreds); });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
    let askedCode = false;
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        if (pairNumber && !askedCode) {
          askedCode = true;
          try { const code = await sock.requestPairingCode(pairNumber); if (onQr) await onQr(null, code); } catch (e) { resolve({ ok: false, reason: 'pair_error', error: e.message }); }
        } else if (!pairNumber && onQr) {
          await onQr(u.qr, null);
        }
      }
      if (u.connection === 'open') { clearTimeout(timer); resolve({ ok: true }); }
      if (u.connection === 'close') {
        clearTimeout(timer);
        const code = u.lastDisconnect?.error?.output?.statusCode;
        resolve({ ok: false, reason: code === DisconnectReason.restartRequired ? 'restart' : code === DisconnectReason.loggedOut ? 'logged_out' : 'closed', code });
      }
    });
  });
  return { sock, result, flush: () => credsWrite };
}

function closeSocket(sock) {
  try { sock.ev.removeAllListeners(); sock.end(undefined); } catch { /* nada */ }
}

// ---------- vincular (desde el panel) ----------
// Mantiene la conexión abierta mientras el dueño escanea. Corre hasta ~50 s; si no escanea a tiempo, se vuelve a pedir.
export async function startLink({ pairNumber } = {}) {
  if (await isRegistered()) {
    const st = await linkStatus();
    if (st.linked) return st;
  }
  if (!(await lock(70))) return linkStatus();
  try {
    await clearSession();
    await setLink({ state: 'waiting', qr: '', pairingCode: '', error: '', number: '' });
    const deadline = Date.now() + 50000;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      const { sock, result, flush } = await openSocket({
        pairNumber: attempt === 0 ? pairNumber : undefined,
        timeoutMs: Math.max(1000, deadline - Date.now()),
        onQr: async (qr, code) => {
          if (qr) await setLink({ state: 'waiting', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
          if (code) await setLink({ state: 'waiting', pairingCode: code });
        },
      });
      await flush();
      if (result.ok) {
        const number = (sock.user?.id || '').split(':')[0].split('@')[0];
        await sleep(1500); // deja terminar la sincronización inicial
        await flush();
        closeSocket(sock);
        return setLink({ state: 'linked', qr: '', pairingCode: '', number, error: '' });
      }
      closeSocket(sock);
      // Después de escanear, WhatsApp pide reconectar: se sigue con la sesión ya guardada.
      if (result.reason === 'restart') continue;
      if (result.reason === 'timeout') return setLink({ state: 'expired', qr: '', pairingCode: '' });
      return setLink({ state: 'error', qr: '', pairingCode: '', error: result.error || `WhatsApp cerró la conexión (${result.code || result.reason}).` });
    }
    return setLink({ state: 'expired', qr: '', pairingCode: '' });
  } finally {
    await unlock();
  }
}

export async function unlink() {
  if (await isRegistered()) {
    try {
      const { sock, result } = await openSocket({ timeoutMs: 15000 });
      if (result.ok) await sock.logout().catch(() => {});
      closeSocket(sock);
    } catch { /* igual se borra */ }
  }
  await clearSession();
  await setLink({ state: 'none', qr: '', pairingCode: '', number: '', error: '' });
}

// ---------- enviar ----------
// messages: [{ key, phone, text }] -> [{ key, ok, error?, retry? }]
export async function sendMessages(messages) {
  if (!messages.length) return [];
  if (!(await isRegistered())) return messages.map((m) => ({ key: m.key, ok: false, transient: true, error: 'WhatsApp no está vinculado' }));
  if (!(await lock(55))) return messages.map((m) => ({ key: m.key, ok: false, transient: true, error: 'Otra conexión en curso' }));
  const results = [];
  let sock;
  try {
    const opened = await openSocket({ timeoutMs: 20000 });
    sock = opened.sock;
    if (!opened.result.ok) {
      if (opened.result.reason === 'logged_out') {
        await clearSession();
        await setLink({ state: 'logged_out', error: 'Se cerró la sesión desde el celular. Volvé a vincular WhatsApp.' });
      }
      return messages.map((m) => ({ key: m.key, ok: false, transient: true, error: 'No se pudo conectar a WhatsApp' }));
    }
    const started = Date.now();
    for (const m of messages) {
      if (Date.now() - started > 40000) { results.push({ key: m.key, ok: false, transient: true, error: 'Sin tiempo, va en la próxima' }); continue; }
      try {
        const [info] = (await sock.onWhatsApp(m.phone)) || [];
        if (!info || !info.exists) { results.push({ key: m.key, ok: false, error: 'El número no tiene WhatsApp' }); continue; }
        await sock.sendMessage(info.jid, { text: m.text });
        results.push({ key: m.key, ok: true });
      } catch (e) {
        results.push({ key: m.key, ok: false, retry: true, error: String(e.message || e).slice(0, 100) });
      }
      await sleep(1500 + Math.random() * 2500);
    }
    await sleep(1000);
    await opened.flush();
    await setLink({ lastSend: new Date().toISOString() });
    return results;
  } finally {
    if (sock) closeSocket(sock);
    await unlock();
  }
}
