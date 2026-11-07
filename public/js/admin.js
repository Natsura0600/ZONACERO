(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const dt = (d) => new Date(d + 'T12:00:00Z');
  const fmt = (d, o) => new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', ...o }).format(dt(d)).replace(/\./g, '');
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const rid = (p) => p + Math.random().toString(36).slice(2, 9);
  const waLink = (phone) => (/^\d{10}$/.test(phone) ? `https://wa.me/549${phone}` : '');

  const TOKEN_KEY = 'zc:admin-token';
  const tokenStore = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* nada */ } },
  };
  let token = tokenStore.get();

  const S = {
    cfg: null, saved: '', today: '', nowMin: 0, tab: 'agenda',
    ag: { start: '', sel: '', data: null },
    clients: null, filter: 'all', q: '', editing: '',
    modal: null,
  };
  const savedCfg = () => JSON.parse(S.saved);

  // ---------- API ----------
  async function api(action, data = {}) {
    let res;
    try {
      res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ action, ...data }),
      });
    } catch {
      throw new Error('Sin conexión. Revisá internet y probá de nuevo.');
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && !['login', 'setup', 'changePassword'].includes(action)) {
      token = '';
      tokenStore.set('');
      showGate('login', json.error || 'Volvé a entrar.');
      throw new Error(json.error || 'Tenés que iniciar sesión.');
    }
    if (!res.ok) {
      const err = new Error(json.error || 'Algo falló. Probá de nuevo.');
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2600);
  }
  const fail = (e) => toast(e.message, true);

  // ---------- acceso ----------
  let gateMode = 'login';
  function showGate(mode, text = '') {
    gateMode = mode;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#gate-error').hidden = true;
    const form = $('#gate-form');
    const db = $('#gate-db');
    form.hidden = mode === 'db';
    db.hidden = mode !== 'db';
    $('#gate-confirm-wrap').hidden = mode !== 'setup';
    $('#gate-pass').value = '';
    $('#gate-pass2').value = '';
    if (mode === 'db') {
      $('#gate-title').textContent = 'Falta un paso';
      $('#gate-text').textContent = 'El sitio está publicado, pero todavía no tiene base de datos para guardar turnos y clientes.';
    } else if (mode === 'setup') {
      $('#gate-title').textContent = 'Bienvenido';
      $('#gate-text').textContent = text || 'Elegí la contraseña para entrar al panel. Guardala bien: solo vos la vas a usar.';
      $('#gate-label').textContent = 'Nueva contraseña (mínimo 6 caracteres)';
      $('#gate-pass').autocomplete = 'new-password';
      $('#gate-btn').textContent = 'Crear contraseña y entrar';
    } else {
      $('#gate-title').textContent = 'Panel';
      $('#gate-text').textContent = text || 'Entrá con tu contraseña.';
      $('#gate-label').textContent = 'Contraseña';
      $('#gate-pass').autocomplete = 'current-password';
      $('#gate-btn').textContent = 'Entrar';
    }
    if (mode !== 'db') setTimeout(() => $('#gate-pass').focus(), 30);
  }

  $('#gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#gate-error');
    const pw = $('#gate-pass').value;
    err.hidden = true;
    if (gateMode === 'setup') {
      if (pw.length < 6) { err.textContent = 'Usá al menos 6 caracteres.'; err.hidden = false; return; }
      if (pw !== $('#gate-pass2').value) { err.textContent = 'Las contraseñas no coinciden.'; err.hidden = false; return; }
    }
    const btn = $('#gate-btn');
    btn.disabled = true;
    try {
      const r = await api(gateMode === 'setup' ? 'setup' : 'login', { password: pw });
      token = r.token;
      tokenStore.set(token);
      await openApp();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('#logout').addEventListener('click', () => {
    if (isDirty() && !confirm('Tenés cambios sin guardar. ¿Salir igual?')) return;
    token = '';
    tokenStore.set('');
    showGate('login', 'Cerraste sesión.');
  });

  async function boot() {
    try {
      const st = await api('status');
      if (!st.dbReady) return showGate('db');
      if (st.needsSetup) return showGate('setup');
      if (!token) return showGate('login');
      await openApp();
    } catch (e) {
      if ($('#gate').hidden && $('#app').hidden) showGate('login', e.message);
    }
  }

  async function openApp() {
    const r = await api('getConfig');
    S.cfg = r.config;
    S.saved = JSON.stringify(r.config);
    S.today = r.today;
    S.ag.start = S.ag.sel = r.today;
    S.clients = null;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#bar-brand').textContent = S.cfg.business.name;
    const fromHash = location.hash.slice(1);
    switchTab(['agenda', 'clientes', 'servicios', 'horarios', 'galeria', 'sitio'].includes(fromHash) ? fromHash : 'agenda');
    updateSavebar();
  }

  // ---------- pestañas ----------
  function switchTab(name) {
    S.tab = name;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    render();
    window.scrollTo(0, 0);
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  function render() {
    if (S.tab === 'agenda') { loadAgenda(); renderNudge(); }
    if (S.tab === 'clientes') S.clients ? renderClients() : loadClients();
    if (S.tab === 'servicios') renderServices();
    if (S.tab === 'horarios') renderHorarios();
    if (S.tab === 'galeria') loadGallery();
    if (S.tab === 'sitio') { renderSitio(); renderNotify(); renderReminders(); }
  }

  // ---------- guardar configuración ----------
  const isDirty = () => S.cfg && JSON.stringify(S.cfg) !== S.saved;
  function updateSavebar() {
    const d = isDirty();
    $('#savebar').hidden = !d;
    document.body.classList.toggle('has-savebar', d);
  }
  $('#save').addEventListener('click', async () => {
    const btn = $('#save');
    btn.disabled = true;
    try {
      const r = await api('saveConfig', { config: S.cfg });
      S.cfg = r.config;
      S.saved = JSON.stringify(r.config);
      $('#bar-brand').textContent = S.cfg.business.name;
      toast('Cambios guardados. Ya se ven en el sitio.');
      render();
    } catch (e) { fail(e); } finally { btn.disabled = false; updateSavebar(); }
  });
  $('#discard').addEventListener('click', () => {
    S.cfg = savedCfg();
    render();
    updateSavebar();
  });
  window.addEventListener('beforeunload', (ev) => { if (isDirty()) { ev.preventDefault(); ev.returnValue = ''; } });

  // enlace de campos con data-bind="ruta.al.valor"
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = val;
  }
  function onBind(ev) {
    const el = ev.target.closest('[data-bind]');
    if (!el || !S.cfg) return;
    let v = el.value;
    if (el.dataset.type === 'int') v = Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : 0;
    if (el.dataset.type === 'bool') v = el.checked;
    setPath(S.cfg, el.dataset.bind, v);
    if (ev.type === 'change' && el.hasAttribute('data-rerender')) render();
    updateSavebar();
  }
  $('#app').addEventListener('input', onBind);
  $('#app').addEventListener('change', onBind);

  // ---------- AGENDA ----------
  async function loadAgenda() {
    try {
      const r = await api('range', { from: S.ag.start, days: 7 });
      S.ag.data = r;
      S.today = r.today;
      S.nowMin = r.nowMinutes;
      if (!r.days.some((d) => d.date === S.ag.sel)) S.ag.sel = r.days[0].date;
      renderAgenda();
    } catch (e) {
      $('#ag-slots').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderAgenda() {
    const cfg = savedCfg();
    const { days } = S.ag.data;
    $('#ag-date').value = S.ag.sel;

    $('#ag-strip').innerHTML = days.map((d) => {
      const n = d.entries.filter((e) => !e.blocked).length;
      const closed = d.closedByDate || !d.slots.length;
      return `<button type="button" class="sday${d.date === S.today ? ' is-today' : ''}${closed ? ' is-closed' : ''}" data-ag="pick" data-date="${d.date}" aria-pressed="${d.date === S.ag.sel}">
        <span class="sday__wd">${d.date === S.today ? 'Hoy' : esc(fmt(d.date, { weekday: 'short' }))}</span>
        <span class="sday__n">${fmt(d.date, { day: 'numeric' })}</span>
        <span class="sday__c${n ? ' has' : ''}">${closed && !n ? 'cerrado' : n + (n === 1 ? ' turno' : ' turnos')}</span>
      </button>`;
    }).join('');

    const day = days.find((d) => d.date === S.ag.sel);
    const bookings = day.entries.filter((e) => !e.blocked);
    const done = bookings.filter((b) => b.status === 'atendido');
    const expected = bookings.filter((b) => b.status !== 'ausente').reduce((a, b) => a + (b.price || 0), 0);
    let toggle = '';
    if (day.closedByDate) toggle = '<button class="btn btn--ghost btn--sm" type="button" data-ag="toggle-day">Abrir este día</button>';
    else if (!day.closedByWeek) toggle = '<button class="btn btn--ghost btn--sm" type="button" data-ag="toggle-day">Cerrar este día</button>';
    $('#ag-dayhead').innerHTML = `
      <div>
        <h2>${esc(fmt(day.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
        <div class="dayhead__stats">
          <span><b>${bookings.length}</b> ${bookings.length === 1 ? 'turno' : 'turnos'}</span>
          <span><b>${done.length}</b> ${done.length === 1 ? 'atendido' : 'atendidos'}</span>
          <span><b>${money.format(expected)}</b> estimado</span>
        </div>
      </div>
      ${toggle}`;

    const active = cfg.barbers.filter((b) => b.active);
    const cols = [...active];
    for (const e of day.entries) if (!cols.some((c) => c.id === e.barberId)) cols.push({ id: e.barberId, name: e.barberName || 'Otro', active: false });
    const multi = cols.length > 1;
    const times = [...new Set([...day.slots, ...day.entries.map((e) => e.time)])].sort();
    const step = cfg.schedule.slotMinutes;

    if (!times.length) {
      const why = day.closedByDate ? 'Marcaste este día como cerrado.' : 'Según tus horarios, este día no se atiende.';
      $('#ag-slots').innerHTML = `<div class="empty"><b>Día cerrado</b>${why} Podés cambiarlo en la pestaña Horarios.</div>`;
      return;
    }

    $('#ag-slots').innerHTML = times.map((t) => {
      const past = day.date < S.today || (day.date === S.today && toMin(t) + step <= S.nowMin);
      const cells = cols.map((b) => {
        const e = day.entries.find((x) => x.field === `${t}|${b.id}`);
        if (e) return e.blocked ? blockedCell(e, multi) : bookingCell(e, multi);
        if (b.active && day.slots.includes(t)) return freeCell(t, b, multi, past);
        return '';
      }).join('');
      if (!cells) return '';
      return `<div class="srow${past ? ' is-past' : ''}"><div class="srow__t">${t}</div><div class="srow__cells">${cells}</div></div>`;
    }).join('');
  }

  function reminderLabel(e) {
    const r = e.reminder;
    if (!r) return '';
    if (r.status === 'sent') return '<span class="cell__rem is-sent">✓ Recordatorio enviado</span>';
    if (r.status === 'failed') return `<span class="cell__rem is-failed" title="${esc(r.error || '')}">Recordatorio no enviado${r.error ? ': ' + esc(r.error) : ''}</span>`;
    return '<span class="cell__rem">Reintentando recordatorio…</span>';
  }

  function freeCell(t, b, multi, past) {
    return `<div class="cell cell--free">
      <span>${multi ? `<span class="cell__who">${esc(b.name)}</span> · ` : ''}Libre</span>
      ${past ? '' : `<span class="cell__actions">
        <button class="btn btn--ghost btn--xs" type="button" data-ag="new" data-time="${t}" data-barber="${esc(b.id)}">+ Turno</button>
        <button class="btn btn--ghost btn--xs" type="button" data-ag="block" data-time="${t}" data-barber="${esc(b.id)}">Bloquear</button>
      </span>`}
    </div>`;
  }

  function blockedCell(e, multi) {
    return `<div class="cell cell--blocked">
      <span>${multi ? `<span class="cell__who">${esc(e.barberName)}</span> · ` : ''}Bloqueado</span>
      <button class="btn btn--ghost btn--xs" type="button" data-ag="remove" data-field="${esc(e.field)}">Desbloquear</button>
    </div>`;
  }

  function bookingCell(e, multi) {
    const labels = { confirmado: 'Confirmado', atendido: 'Atendido · sumó sello', ausente: 'No vino' };
    const wa = waLink(e.phone);
    let actions;
    if (e.status === 'confirmado') {
      actions = `
        <button class="btn btn--ok btn--xs" type="button" data-ag="status" data-status="atendido" data-field="${esc(e.field)}">✓ Atendido</button>
        <button class="btn btn--ghost btn--xs" type="button" data-ag="status" data-status="ausente" data-field="${esc(e.field)}">No vino</button>
        <button class="btn btn--danger btn--xs" type="button" data-ag="remove" data-field="${esc(e.field)}" data-name="${esc(e.name)}">Cancelar turno</button>`;
    } else if (e.status === 'atendido') {
      actions = `<button class="btn btn--ghost btn--xs" type="button" data-ag="status" data-status="confirmado" data-field="${esc(e.field)}">Deshacer</button>`;
    } else {
      actions = `
        <button class="btn btn--ghost btn--xs" type="button" data-ag="status" data-status="confirmado" data-field="${esc(e.field)}">Deshacer</button>
        <button class="btn btn--ghost btn--xs" type="button" data-ag="remove" data-field="${esc(e.field)}" data-name="${esc(e.name)}">Liberar horario</button>`;
    }
    return `<div class="cell cell--booking is-${esc(e.status)}">
      <div class="cell__top">
        <span class="cell__name">${esc(e.name)}</span>
        <span class="pill pill--${esc(e.status)}">${labels[e.status] || esc(e.status)}</span>
      </div>
      <div class="cell__meta">
        <span>${esc(e.serviceName)} · ${money.format(e.price || 0)}</span>
        ${multi ? `<span>${esc(e.barberName)}</span>` : ''}
        ${wa ? `<a href="${wa}" target="_blank" rel="noopener">${esc(e.phoneRaw || e.phone)}</a>` : `<span>${esc(e.phoneRaw || e.phone)}</span>`}
        <span>Código <span class="cell__code">${esc(e.code)}</span></span>
        ${reminderLabel(e)}
        <span>${e.source === 'panel' ? 'Cargado por vos' : 'Reservó online'}</span>
      </div>
      <div class="cell__actions">${actions}</div>
    </div>`;
  }

  $('#view-agenda').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-ag]');
    if (!b) return;
    const act = b.dataset.ag;
    const date = S.ag.sel;
    if (act === 'pick') { S.ag.sel = b.dataset.date; renderAgenda(); return; }
    if (act === 'new') { openModal(date, b.dataset.time, b.dataset.barber); return; }
    if (act === 'remove' && b.dataset.name && !confirm(`¿Cancelar el turno de ${b.dataset.name}? El horario queda libre.`)) return;
    b.disabled = true;
    try {
      if (act === 'status') {
        await api('setStatus', { date, field: b.dataset.field, status: b.dataset.status });
        if (b.dataset.status === 'atendido') toast('Listo: se sumó un sello.');
        S.clients = null;
      } else if (act === 'remove') {
        await api('remove', { date, field: b.dataset.field });
        toast(b.dataset.name ? 'Turno cancelado.' : 'Horario desbloqueado.');
        S.clients = null;
      } else if (act === 'block') {
        await api('block', { date, time: b.dataset.time, barberId: b.dataset.barber });
        toast('Horario bloqueado.');
      } else if (act === 'toggle-day') {
        const r = await api('toggleDay', { date });
        const saved = savedCfg();
        saved.closedDates = r.config.closedDates;
        S.saved = JSON.stringify(saved);
        S.cfg.closedDates = r.config.closedDates;
        updateSavebar();
        toast(r.config.closedDates.includes(date) ? 'Día cerrado: nadie puede reservar.' : 'Día abierto.');
      }
      await loadAgenda();
    } catch (e) {
      fail(e);
      b.disabled = false;
    }
  });

  $('#ag-prev').addEventListener('click', () => { S.ag.start = S.ag.sel = addDays(S.ag.start, -7); loadAgenda(); });
  $('#ag-next').addEventListener('click', () => { S.ag.start = S.ag.sel = addDays(S.ag.start, 7); loadAgenda(); });
  $('#ag-today').addEventListener('click', () => { S.ag.start = S.ag.sel = S.today; loadAgenda(); });
  $('#ag-date').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    S.ag.start = S.ag.sel = ev.target.value;
    loadAgenda();
  });

  // ---------- modal de turno ----------
  async function openModal(date, time, barberId) {
    const cfg = savedCfg();
    const barber = cfg.barbers.find((b) => b.id === barberId);
    S.modal = { date, time, barberId };
    $('#bk-when').textContent = `${fmt(date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${time} h${cfg.barbers.filter((b) => b.active).length > 1 && barber ? ' · ' + barber.name : ''}`;
    $('#bk-name').value = '';
    $('#bk-phone').value = '';
    $('#bk-error').hidden = true;
    const svcs = [...cfg.services].sort((a, b) => Number(b.active) - Number(a.active));
    $('#bk-service').innerHTML = svcs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${money.format(s.price)}${s.active ? '' : ' (oculto)'}</option>`).join('');
    $('#bk-modal').showModal();
    $('#bk-name').focus();
    try {
      if (!S.clients) S.clients = (await api('clients')).clients;
      $('#bk-clients').innerHTML = S.clients.map((c) => `<option value="${esc(c.name)}">${esc(c.phoneRaw || c.phone)}</option>`).join('');
    } catch { /* el autocompletado es opcional */ }
  }

  $('#bk-name').addEventListener('input', () => {
    if (!S.clients) return;
    const c = S.clients.find((x) => x.name.toLowerCase() === $('#bk-name').value.trim().toLowerCase());
    if (c && !$('#bk-phone').value) $('#bk-phone').value = c.phoneRaw || c.phone;
  });
  $('#bk-cancel').addEventListener('click', () => $('#bk-modal').close());
  $('#bk-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#bk-error');
    err.hidden = true;
    try {
      await api('addBooking', {
        ...S.modal,
        serviceId: $('#bk-service').value,
        name: $('#bk-name').value,
        phone: $('#bk-phone').value,
      });
      $('#bk-modal').close();
      S.clients = null;
      toast('Turno agendado.');
      loadAgenda();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  // ---------- CLIENTES ----------
  async function loadClients() {
    $('#cl-list').innerHTML = '<p class="muted">Cargando clientes…</p>';
    try {
      S.clients = (await api('clients')).clients;
      renderClients();
    } catch (e) {
      $('#cl-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderClients() {
    const goal = savedCfg().loyalty.goal;
    const all = S.clients || [];
    const withPrize = all.filter((c) => c.stamps >= goal);
    $('#cl-kpis').innerHTML = [
      [all.length, all.length === 1 ? 'cliente' : 'clientes'],
      [withPrize.length, 'con premio para canjear'],
      [all.reduce((a, c) => a + (c.visits || 0), 0), 'visitas registradas'],
      [all.reduce((a, c) => a + (c.rewards || 0), 0), 'premios canjeados'],
    ].map(([v, l]) => `<div class="kpi"><div class="kpi__v">${v}</div><div class="kpi__l">${l}</div></div>`).join('');

    const q = S.q.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    let list = S.filter === 'prize' ? withPrize : all;
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || (qd && c.phone.includes(qd)));

    if (!all.length) {
      $('#cl-list').innerHTML = '<div class="empty"><b>Todavía no hay clientes</b>Se agregan solos cuando alguien saca turno. También podés cargarlos con “Nuevo cliente”.</div>';
      return;
    }
    if (!list.length) {
      $('#cl-list').innerHTML = '<div class="empty">No hay clientes que coincidan.</div>';
      return;
    }
    $('#cl-list').innerHTML = list.map((c) => {
      const prize = c.stamps >= goal;
      const wa = waLink(c.phone);
      const dots = Array.from({ length: goal }, (_, i) => `<span class="dot${i < Math.min(c.stamps, goal) ? ' is-on' : ''}"></span>`).join('');
      const editing = S.editing === c.phone;
      return `<div class="client${prize ? ' has-prize' : ''}" data-phone="${esc(c.phone)}">
        <div>
          <div class="client__name">${esc(c.name)}</div>
          <div class="client__sub">
            ${wa ? `<a href="${wa}" target="_blank" rel="noopener">${esc(c.phoneRaw || c.phone)}</a>` : `<span>${esc(c.phoneRaw || c.phone)}</span>`}
            <span>${c.lastVisit ? 'Última visita ' + esc(fmt(c.lastVisit, { day: 'numeric', month: 'short' })) : 'Sin visitas todavía'}</span>
          </div>
          ${c.notes ? `<div class="client__notes">${esc(c.notes)}</div>` : ''}
        </div>
        <div>
          <div class="dots">${dots}<span class="dots__n">${c.stamps}/${goal}</span>${prize ? ' <span class="pill pill--confirmado">Premio listo</span>' : ''}</div>
          <div class="client__sub"><span>${c.visits || 0} ${c.visits === 1 ? 'visita' : 'visitas'}</span><span>${c.rewards || 0} ${c.rewards === 1 ? 'premio canjeado' : 'premios canjeados'}</span></div>
        </div>
        <div class="client__actions">
          <button class="btn btn--ghost btn--xs" type="button" data-cl="minus" aria-label="Quitar un sello" ${c.stamps ? '' : 'disabled'}>−</button>
          <button class="btn btn--ok btn--xs" type="button" data-cl="plus">+ Sello</button>
          ${prize ? '<button class="btn btn--accent btn--xs" type="button" data-cl="redeem">Canjear premio</button>' : ''}
          <button class="btn btn--ghost btn--xs" type="button" data-cl="edit">${editing ? 'Cerrar' : 'Editar'}</button>
        </div>
        ${editing ? `<form class="client__edit" data-cl-form novalidate>
          <label class="field"><span>Nombre</span><input name="name" maxlength="60" value="${esc(c.name)}"></label>
          <label class="field"><span>Sellos</span><input name="stamps" type="number" min="0" max="999" value="${c.stamps}"></label>
          <label class="field"><span>Notas (solo las ves vos)</span><input name="notes" maxlength="500" value="${esc(c.notes)}" placeholder="Ej: fade bajo, número 2 a los costados"></label>
          <div class="row-end">
            <button class="btn btn--danger btn--xs" type="button" data-cl="delete">Borrar cliente</button>
            <button class="btn btn--accent btn--xs" type="submit">Guardar</button>
          </div>
        </form>` : ''}
      </div>`;
    }).join('');
  }

  $('#cl-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-cl]');
    if (!b) return;
    const phone = b.closest('[data-phone]').dataset.phone;
    const c = S.clients.find((x) => x.phone === phone);
    const act = b.dataset.cl;
    if (act === 'edit') { S.editing = S.editing === phone ? '' : phone; renderClients(); return; }
    if (act === 'delete' && !confirm(`¿Borrar a ${c.name}? Se pierden sus sellos.`)) return;
    if (act === 'redeem' && !confirm(`¿Canjear el premio de ${c.name}? Se descuentan ${savedCfg().loyalty.goal} sellos.`)) return;
    b.disabled = true;
    try {
      if (act === 'plus' || act === 'minus') await api('stamp', { phone, delta: act === 'plus' ? 1 : -1 });
      if (act === 'redeem') { await api('redeem', { phone }); toast('Premio canjeado.'); }
      if (act === 'delete') { await api('deleteClient', { phone }); S.editing = ''; toast('Cliente borrado.'); }
      await loadClients();
    } catch (e) { fail(e); b.disabled = false; }
  });

  $('#cl-list').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target.closest('[data-cl-form]');
    const phone = form.closest('[data-phone]').dataset.phone;
    try {
      await api('updateClient', { phone, name: form.name.value, notes: form.notes.value, stamps: form.stamps.value });
      S.editing = '';
      toast('Cliente actualizado.');
      await loadClients();
    } catch (e) { fail(e); }
  });

  $('#cl-search').addEventListener('input', (ev) => { S.q = ev.target.value; renderClients(); });
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    $$('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderClients();
  }));
  $('#cl-new-open').addEventListener('click', () => { $('#cl-new').hidden = false; $('#cl-new-name').focus(); });
  $('#cl-new-cancel').addEventListener('click', () => { $('#cl-new').hidden = true; });
  $('#cl-new').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('addClient', { name: $('#cl-new-name').value, phone: $('#cl-new-phone').value, stamps: $('#cl-new-stamps').value });
      $('#cl-new').hidden = true;
      $('#cl-new-name').value = '';
      $('#cl-new-phone').value = '';
      $('#cl-new-stamps').value = '0';
      toast('Cliente agregado.');
      await loadClients();
    } catch (e) { fail(e); }
  });

  // ---------- SERVICIOS ----------
  function renderServices() {
    const list = S.cfg.services;
    $('#sv-list').innerHTML = list.length ? list.map((s, i) => `
      <div class="svc${s.active ? '' : ' is-off'}">
        <label class="field"><span>Nombre</span><input data-bind="services.${i}.name" maxlength="60" value="${esc(s.name)}"></label>
        <label class="field"><span>Precio ($)</span><input type="number" min="0" step="100" inputmode="numeric" data-bind="services.${i}.price" data-type="int" value="${s.price}"></label>
        <div class="svc__tools">
          <label class="field field--check"><input type="checkbox" data-bind="services.${i}.active" data-type="bool" data-rerender ${s.active ? 'checked' : ''}><span>Visible</span></label>
          <div class="svc__side">
            <button class="btn btn--icon btn--xs" type="button" data-act="up-service" data-i="${i}" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn--icon btn--xs" type="button" data-act="down-service" data-i="${i}" aria-label="Bajar" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="x" type="button" data-act="del-service" data-i="${i}" aria-label="Borrar ${esc(s.name)}">×</button>
          </div>
        </div>
        <label class="field svc__desc"><span>Descripción</span><input data-bind="services.${i}.desc" maxlength="200" value="${esc(s.desc)}"></label>
      </div>`).join('')
      : '<div class="empty"><b>No hay servicios</b>Agregá el primero con “+ Agregar servicio”.</div>';
  }

  // ---------- HORARIOS ----------
  const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  function selectHtml(bind, value, options) {
    const opts = options.some(([v]) => v === value) ? options : [...options, [value, String(value)]];
    return `<select data-bind="${bind}" data-type="int">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  function renderHorarios() {
    const sc = S.cfg.schedule;
    $('#hr-week').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const ranges = sc.week[d] || [];
      const open = ranges.length > 0;
      return `<div class="wday">
        <label class="field field--check"><input type="checkbox" data-day-open="${d}" ${open ? 'checked' : ''}><span>${DAY_NAMES[d]}</span></label>
        <div class="wday__ranges">
          ${open ? ranges.map((r, j) => `
            <div class="range">
              <input type="time" step="300" data-bind="schedule.week.${d}.${j}.from" value="${esc(r.from)}" aria-label="${DAY_NAMES[d]} desde">
              <span>a</span>
              <input type="time" step="300" data-bind="schedule.week.${d}.${j}.to" value="${esc(r.to)}" aria-label="${DAY_NAMES[d]} hasta">
              ${ranges.length > 1 ? `<button class="x" type="button" data-act="del-range" data-day="${d}" data-i="${j}" aria-label="Quitar este horario">×</button>` : ''}
            </div>`).join('') + (ranges.length < 3 ? `<button class="linkish" type="button" data-act="add-range" data-day="${d}">+ Horario cortado</button>` : '')
            : '<span class="muted">Cerrado</span>'}
        </div>
      </div>`;
    }).join('');

    $('#hr-rules').innerHTML = `
      <label class="field"><span>Duración de cada turno</span>${selectHtml('schedule.slotMinutes', sc.slotMinutes, [15, 20, 30, 40, 45, 60, 90].map((m) => [m, `${m} minutos`]))}</label>
      <label class="field"><span>Se puede reservar hasta</span>${selectHtml('schedule.daysAhead', sc.daysAhead, [7, 14, 21, 30, 45, 60].map((n) => [n, `${n} días antes`]))}</label>
      <label class="field"><span>Anticipación mínima</span>${selectHtml('schedule.minNoticeMinutes', sc.minNoticeMinutes, [[0, 'Sin mínimo'], [30, '30 minutos'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [720, '12 horas'], [1440, '1 día']])}</label>
      <label class="field"><span>Turnos a futuro por cliente</span>${selectHtml('schedule.maxActivePerClient', sc.maxActivePerClient, [1, 2, 3, 5].map((n) => [n, n === 1 ? '1 turno' : `${n} turnos`]))}</label>`;

    const upcoming = S.cfg.closedDates.filter((d) => d >= S.today);
    $('#hr-closed').innerHTML = upcoming.length
      ? upcoming.map((d) => `<span class="chip">${esc(fmt(d, { weekday: 'short', day: 'numeric', month: 'short' }))}<button class="x" type="button" data-act="del-closed" data-date="${d}" aria-label="Quitar">×</button></span>`).join('')
      : '<span class="muted">No hay días cerrados próximos.</span>';
    $('#hr-closed-date').min = S.today;

    const bs = S.cfg.barbers;
    $('#hr-barbers').innerHTML = bs.map((b, i) => `
      <div class="barber">
        <input data-bind="barbers.${i}.name" maxlength="40" value="${esc(b.name)}" aria-label="Nombre del barbero">
        <label class="field field--check"><input type="checkbox" data-bind="barbers.${i}.active" data-type="bool" ${b.active ? 'checked' : ''}><span>Atiende</span></label>
        <button class="x" type="button" data-act="del-barber" data-i="${i}" aria-label="Borrar" ${bs.length === 1 ? 'disabled' : ''}>×</button>
      </div>`).join('');
  }

  $('#view-horarios').addEventListener('change', (ev) => {
    const cb = ev.target.closest('[data-day-open]');
    if (!cb) return;
    const d = cb.dataset.dayOpen;
    S.cfg.schedule.week[d] = cb.checked ? [{ from: '10:00', to: '20:00' }] : [];
    renderHorarios();
    updateSavebar();
  });

  // ---------- SITIO ----------
  const PRESETS = [['#d8382c', 'Rojo'], ['#d2601a', 'Naranja'], ['#b5832a', 'Dorado'], ['#1f9257', 'Verde'], ['#2b63d9', 'Azul'], ['#7a4bd6', 'Violeta']];
  const ZONES = [
    ['America/Argentina/Buenos_Aires', 'Argentina'], ['America/Montevideo', 'Uruguay'], ['America/Santiago', 'Chile'],
    ['America/Asuncion', 'Paraguay'], ['America/Bogota', 'Colombia'], ['America/Lima', 'Perú'],
    ['America/Mexico_City', 'México (CDMX)'], ['Europe/Madrid', 'España'],
  ];

  function renderSitio() {
    const b = S.cfg.business;
    const l = S.cfg.loyalty;
    const input = (path, label, val, max, ph = '') => `<label class="field"><span>${label}</span><input data-bind="${path}" maxlength="${max}" value="${esc(val)}" placeholder="${esc(ph)}"></label>`;
    const area = (path, label, val, max, ph = '') => `<label class="field"><span>${label}</span><textarea data-bind="${path}" maxlength="${max}" placeholder="${esc(ph)}">${esc(val)}</textarea></label>`;
    const zones = ZONES.some(([z]) => z === S.cfg.timezone) ? ZONES : [...ZONES, [S.cfg.timezone, S.cfg.timezone]];
    $('#st-form').innerHTML = `
      <div class="block">
        <h2>Portada</h2>
        <div class="grid3">
          ${input('business.name', 'Nombre de la barbería', b.name, 40)}
          ${input('business.tagline', 'Bajada (arriba del nombre)', b.tagline, 60, 'Barbería')}
          ${input('business.heroTitle', 'Frase principal', b.heroTitle, 90)}
        </div>
        ${area('business.heroText', 'Texto de presentación', b.heroText, 320)}
        ${input('business.announcement', 'Aviso destacado (franja de color arriba de todo, opcional)', b.announcement, 140, 'Ej: Esta semana 20% off en barba')}
        ${area('business.about', 'Sobre la barbería (opcional, aparece debajo de la portada)', b.about, 900)}
      </div>
      <div class="block">
        <h2>Redes (opcional)</h2>
        <p class="muted">Aparecen en el pie de página. Dejalos vacíos para no mostrarlos.</p>
        <div class="grid3">
          ${input('business.instagram', 'Instagram (sin @)', b.instagram, 60, 'zonacero.barber')}
          ${input('business.whatsapp', 'WhatsApp', b.whatsapp, 24, '11 2345 6789')}
        </div>
      </div>
      <div class="block">
        <h2>Tarjeta de sellos</h2>
        <label class="field field--check"><input type="checkbox" data-bind="loyalty.enabled" data-type="bool" ${l.enabled ? 'checked' : ''}><span>Mostrar la tarjeta de sellos en el sitio</span></label>
        <div class="grid3">
          <label class="field"><span>Sellos para el premio</span><input type="number" min="2" max="30" data-bind="loyalty.goal" data-type="int" value="${l.goal}"></label>
          ${input('loyalty.reward', 'Premio', l.reward, 60, 'Corte gratis')}
        </div>
        ${area('loyalty.text', 'Cómo funciona (texto para el cliente)', l.text, 320)}
      </div>
      <div class="block">
        <h2>Color y zona horaria</h2>
        <div class="grid3">
          <div class="field"><span>Color principal</span>
            <div class="swatches">
              ${PRESETS.map(([c, n]) => `<button type="button" class="swatch" style="background:${c}" data-act="accent" data-color="${c}" aria-label="${n}" aria-pressed="${S.cfg.theme.accent.toLowerCase() === c}"></button>`).join('')}
              <input type="color" data-bind="theme.accent" data-rerender value="${esc(S.cfg.theme.accent)}" aria-label="Otro color">
            </div>
          </div>
          <label class="field"><span>Zona horaria</span>
            <select data-bind="timezone">${zones.map(([z, n]) => `<option value="${esc(z)}" ${z === S.cfg.timezone ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          </label>
        </div>
      </div>`;
  }

  // ---------- AVISOS (Web Push) ----------
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const deviceName = () => {
    const os = isIOS ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Dispositivo';
    const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return br ? `${os} · ${br}` : os;
  };
  const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  let swReg = null;
  async function getReg() {
    if (!pushSupported) return null;
    if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return swReg;
  }
  async function currentSub() {
    try { const r = await getReg(); return r ? await r.pushManager.getSubscription() : null; } catch { return null; }
  }

  // Devuelve un texto si este dispositivo no puede activar avisos.
  function pushBlocker() {
    if (isIOS && !standalone) return 'En iPhone: tocá Compartir → “Agregar a inicio”, abrí el panel desde ese ícono y activá los avisos ahí.';
    if (!pushSupported) return 'Este navegador no permite notificaciones. Probá con Chrome en Android, o con Safari en iPhone agregando el panel a inicio.';
    if (Notification.permission === 'denied') return 'Bloqueaste las notificaciones para este sitio. Habilitalas en los ajustes del navegador y volvé a intentar.';
    return '';
  }

  async function enablePush() {
    const blocker = pushBlocker();
    if (blocker) { toast(blocker, true); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Sin permiso no se pueden mandar avisos. Tocá “Permitir” cuando el celular pregunte.', true); return false; }
    const { publicKey } = await api('pushKey');
    const reg = await getReg();
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const old = sub.options && sub.options.applicationServerKey;
      const same = old && btoa(String.fromCharCode(...new Uint8Array(old))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey;
      if (!same) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      } catch {
        toast('Este navegador no pudo activar los avisos. Probá con Chrome en Android o con el panel agregado a inicio en iPhone.', true);
        return false;
      }
    }
    await api('pushSubscribe', { subscription: sub.toJSON(), device: deviceName() });
    try { localStorage.removeItem('zc:nudge-off'); } catch { /* nada */ }
    toast('Avisos activados en este dispositivo.');
    return true;
  }

  async function renderNotify() {
    const status = $('#nt-status');
    let devices = [];
    try { devices = (await api('pushKey')).devices; } catch (e) { status.textContent = e.message; return; }
    const sub = await currentSub();
    const here = sub && devices.some((d) => d.endpoint === sub.endpoint);
    const blocker = here ? '' : pushBlocker();
    status.classList.toggle('is-on', Boolean(here));
    status.textContent = here ? 'Activados en este dispositivo.' : blocker || 'Todavía no están activados en este dispositivo.';
    $('#nt-on').hidden = Boolean(here || blocker);
    $('#nt-off').hidden = !here;
    $('#nt-test').hidden = !devices.length;
    $('#nt-devices').innerHTML = devices.map((d) => `<li><span>${esc(d.device)}${sub && d.endpoint === sub.endpoint ? ' <small>(este)</small>' : ''}<br><small>Desde ${esc(fmt(d.createdAt.slice(0, 10), { day: 'numeric', month: 'short' }))}</small></span>
      <button class="x" type="button" data-dev="${esc(d.id)}" aria-label="Quitar ${esc(d.device)}">×</button></li>`).join('');
  }

  async function renderNudge() {
    let off = false;
    try { off = localStorage.getItem('zc:nudge-off') === '1'; } catch { /* nada */ }
    const sub = await currentSub();
    const show = !off && !sub && (pushSupported || isIOS) && window.Notification?.permission !== 'denied';
    $('#nudge').hidden = !show;
    if (show && isIOS && !standalone) {
      $('#nudge-text').textContent = 'Para recibir avisos de turnos nuevos en el iPhone: Compartir → “Agregar a inicio”, y abrí el panel desde ese ícono.';
      $('#nudge-on').hidden = true;
    }
  }

  $('#nt-on').addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try { await enablePush(); } catch (e) { fail(e); }
    ev.currentTarget.disabled = false;
    renderNotify();
  });
  $('#nt-off').addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const sub = await currentSub();
      if (sub) { await api('pushUnsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      toast('Avisos desactivados en este dispositivo.');
    } catch (e) { fail(e); }
    ev.currentTarget.disabled = false;
    renderNotify();
  });
  $('#nt-devices').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-dev]');
    if (!b) return;
    try { await api('pushUnsubscribe', { id: b.dataset.dev }); } catch (e) { fail(e); }
    renderNotify();
  });
  $('#nt-test').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      const r = await api('testNotify');
      toast(r.failed ? `Enviado a ${r.ok} de ${r.devices} dispositivos.` : 'Aviso enviado. Fijate en tu celular.');
    } catch (e) { fail(e); } finally { b.disabled = false; renderNotify(); }
  });
  $('#nudge-on').addEventListener('click', async () => {
    try { if (await enablePush()) $('#nudge').hidden = true; } catch (e) { fail(e); }
  });
  $('#nudge-close').addEventListener('click', () => {
    try { localStorage.setItem('zc:nudge-off', '1'); } catch { /* nada */ }
    $('#nudge').hidden = true;
  });

  $('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const next = $('#pw-next').value;
    if (next.length < 6) { toast('La nueva contraseña tiene que tener al menos 6 caracteres.', true); return; }
    try {
      const r = await api('changePassword', { current: $('#pw-current').value, next });
      token = r.token;
      tokenStore.set(token);
      $('#pw-current').value = '';
      $('#pw-next').value = '';
      toast('Contraseña cambiada. Se cerró la sesión en otros dispositivos.');
    } catch (e) { fail(e); }
  });

  // ---------- RECORDATORIOS ----------
  const VARS = ['nombre', 'cuando', 'hora', 'servicio', 'barbero', 'barberia', 'codigo', 'sitio'];
  let previewTimer;
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'recién';
    if (m < 60) return `hace ${m} min`;
    if (m < 1440) return `hace ${Math.round(m / 60)} h`;
    return `hace ${Math.round(m / 1440)} días`;
  };

  function renderReminders() {
    const r = S.cfg.reminders;
    $('#rm-form').innerHTML = `
      <label class="field field--check"><input type="checkbox" data-bind="reminders.enabled" data-type="bool" ${r.enabled ? 'checked' : ''}><span>Mandar recordatorios automáticos</span></label>
      <div class="grid3">
        <label class="field"><span>Cuándo</span>${selectHtml('reminders.hoursBefore', r.hoursBefore, [[1, '1 hora antes'], [2, '2 horas antes'], [3, '3 horas antes'], [6, '6 horas antes'], [12, '12 horas antes'], [24, '1 día antes']])}</label>
        <label class="field"><span>Código de país para WhatsApp</span><input data-bind="reminders.prefix" inputmode="numeric" maxlength="5" value="${esc(r.prefix)}" placeholder="549"></label>
      </div>
      <label class="field"><span>Mensaje</span><textarea id="rm-template" data-bind="reminders.template" maxlength="600">${esc(r.template)}</textarea></label>
      <div class="field"><span>Tocá para agregar un dato al mensaje</span><div class="vars">${VARS.map((v) => `<button type="button" class="var" data-var="${v}">{${v}}</button>`).join('')}</div></div>
      <p class="muted">No se mandan entre las 22 y las 8 (los que caen en ese horario salen a las 8). Si el cliente reservó hace poco, no se le recuerda.</p>`;
    refreshBot();
  }

  let waLinking = false;
  let waPoll = null;

  async function refreshBot() {
    try {
      const st = await api('waStatus', { reminders: { template: S.cfg.reminders.template } });
      $('#rm-preview').textContent = st.preview;
      renderWa(st);
      return st;
    } catch (e) { $('#wa-status').textContent = e.message; return null; }
  }

  function renderWa(st) {
    const l = st.link;
    const el = $('#wa-status');
    el.classList.toggle('is-on', l.linked);
    el.classList.toggle('is-warn', l.state === 'logged_out' || l.state === 'error');
    const waiting = waLinking || l.state === 'waiting';
    if (l.linked) el.textContent = `Conectado al WhatsApp +${l.number || ''}. Los recordatorios salen desde ese número.`;
    else if (waiting && l.pairingCode) el.textContent = 'Escribí este código en WhatsApp → Dispositivos vinculados → Vincular con número de teléfono:';
    else if (waiting && l.qr) el.textContent = 'Escaneá el código con el WhatsApp de la barbería.';
    else if (waiting) el.textContent = 'Generando el código…';
    else if (l.state === 'expired') el.textContent = 'El código venció antes de escanearlo. Generá uno nuevo.';
    else if (l.state === 'logged_out' || l.state === 'error') el.textContent = l.error || 'Se desconectó WhatsApp. Volvé a vincularlo.';
    else el.textContent = 'WhatsApp todavía no está vinculado.';

    $('#wa-qr').hidden = !(waiting && l.qr && !l.pairingCode);
    if (waiting && l.qr) $('#wa-qr-img').src = l.qr;
    $('#wa-code').hidden = !(waiting && l.pairingCode);
    $('#wa-code').textContent = l.pairingCode ? l.pairingCode.replace(/(.{4})(.{4})/, '$1-$2') : '';
    $('#wa-actions').innerHTML = l.linked
      ? '<button class="btn btn--ghost btn--sm" type="button" data-wa="test">Mandar mensaje de prueba</button><button class="btn btn--ghost btn--sm" type="button" data-wa="run">Revisar y mandar ahora</button><button class="btn btn--danger btn--sm" type="button" data-wa="unlink">Desvincular</button>'
      : waiting ? '' : '<button class="btn btn--accent btn--sm" type="button" data-wa="link">Vincular WhatsApp</button><button class="btn btn--ghost btn--sm" type="button" data-wa="pair">Prefiero un código</button>';
    if (l.linked || waiting) $('#wa-pair').hidden = true;
    if (!l.linked) $('#wa-test').hidden = true;

    const c = st.cron;
    const lr = c.lastRun;
    $('#wa-cron').textContent = !c.secretSet
      ? 'Para que se manden solos falta la variable CRON_SECRET en Vercel (está en el README).'
      : lr ? `Última revisión: ${ago(lr.at)} (${lr.source === 'panel' ? 'manual' : 'automática'}) · ${lr.sent} ${lr.sent === 1 ? 'enviado' : 'enviados'}${lr.failed ? ` · ${lr.failed} con error` : ''}.`
        : 'Todavía no corrió ninguna revisión automática.';
  }

  async function startWaLink(number) {
    waLinking = true;
    renderWa({ link: { state: 'waiting' }, cron: { secretSet: true, lastRun: null } });
    clearInterval(waPoll);
    waPoll = setInterval(refreshBot, 2500);
    try {
      await api('waLink', number ? { number } : {});
    } catch (e) { fail(e); }
    waLinking = false;
    clearInterval(waPoll);
    const st = await refreshBot();
    if (st && st.link.linked) toast('¡WhatsApp vinculado! Ya quedó listo.');
  }

  $('#wa').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-wa]');
    if (!b) return;
    const act = b.dataset.wa;
    if (act === 'link') return startWaLink();
    if (act === 'pair') { $('#wa-pair').hidden = false; $('#wa-pair-number').focus(); return; }
    if (act === 'test') { $('#wa-test').hidden = false; $('#wa-test-phone').focus(); return; }
    b.disabled = true;
    try {
      if (act === 'unlink') {
        if (!confirm('¿Desvincular el WhatsApp? Los recordatorios dejan de salir hasta que lo vuelvas a vincular.')) { b.disabled = false; return; }
        await api('waUnlink');
        toast('WhatsApp desvinculado.');
      }
      if (act === 'run') {
        const { run } = await api('waRunNow');
        toast(run.found ? `Listo: ${run.sent} de ${run.found} recordatorios enviados.` : 'No hay recordatorios para mandar ahora.');
      }
    } catch (e) { fail(e); }
    refreshBot();
  });
  $('#wa-pair').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const n = $('#wa-pair-number').value.replace(/\D/g, '');
    if (n.length < 10) { toast('Escribí el número completo con código de país, por ejemplo 5491123456789.', true); return; }
    $('#wa-pair').hidden = true;
    startWaLink(n);
  });
  $('#wa-test').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter || $('#wa-test button');
    btn.disabled = true;
    try { await api('waTest', { phone: $('#wa-test-phone').value }); toast('Mensaje de prueba enviado.'); $('#wa-test').hidden = true; } catch (e) { fail(e); }
    btn.disabled = false;
  });

  $('#view-sitio').addEventListener('input', (ev) => {
    if (ev.target.id !== 'rm-template') return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshBot, 500);
  });
  $('#view-sitio').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-var]');
    if (!b) return;
    const ta = $('#rm-template');
    const ins = `{${b.dataset.var}}`;
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = at + ins.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ---------- GALERÍA ----------
  let gallery = [];
  const photoUrl = (id) => `/api/site?action=photo&id=${encodeURIComponent(id)}`;

  async function loadGallery() {
    try {
      gallery = (await api('gallery')).gallery;
      renderGallery();
    } catch (e) { $('#gl-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function renderGallery(uploading = 0) {
    const ph = Array.from({ length: uploading }, () => '<div class="gitem is-uploading"><img alt=""><div class="gitem__body"><span class="muted">Subiendo…</span></div></div>').join('');
    if (!gallery.length && !uploading) {
      $('#gl-list').innerHTML = '<div class="empty" style="grid-column:1/-1"><b>Todavía no hay fotos</b>Subí fotos de tus mejores cortes con “+ Subir fotos”. Desde el celular podés sacarlas en el momento.</div>';
      return;
    }
    $('#gl-list').innerHTML = ph + gallery.map((p, i) => `
      <div class="gitem">
        <img src="${photoUrl(p.id)}" alt="${esc(p.caption)}" loading="lazy">
        <div class="gitem__body">
          <input data-gcap="${i}" maxlength="80" value="${esc(p.caption)}" placeholder="Texto (opcional), ej: Fade bajo" aria-label="Texto de la foto">
          <div class="gitem__tools">
            <span class="gitem__n">${i + 1}</span>
            <span class="row-start">
              <button class="btn btn--icon btn--xs" type="button" data-gmove="-1" data-i="${i}" aria-label="Mover antes" ${i === 0 ? 'disabled' : ''}>←</button>
              <button class="btn btn--icon btn--xs" type="button" data-gmove="1" data-i="${i}" aria-label="Mover después" ${i === gallery.length - 1 ? 'disabled' : ''}>→</button>
              <button class="btn btn--danger btn--xs" type="button" data-gdel="${esc(p.id)}">Borrar</button>
            </span>
          </div>
        </div>
      </div>`).join('');
  }

  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error(`“${file.name}” no es una imagen que se pueda abrir.`)); im.src = url; });
      const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      let type = 'image/webp';
      let q = 0.82;
      let data = c.toDataURL(type, q);
      if (!data.startsWith('data:image/webp')) { type = 'image/jpeg'; data = c.toDataURL(type, 0.85); q = 0.85; }
      while (data.length > 900 * 1024 && q > 0.4) { q -= 0.12; data = c.toDataURL(type, q); }
      return { data, w, h };
    } finally { URL.revokeObjectURL(url); }
  }

  $('#gl-file').addEventListener('change', async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (!files.length) return;
    let done = 0;
    for (const f of files) {
      renderGallery(files.length - done);
      try {
        const { data, w, h } = await shrink(f);
        const { item } = await api('galleryAdd', { data, w, h, caption: '' });
        gallery.unshift(item);
        done++;
      } catch (e) { fail(e); done++; }
    }
    renderGallery();
    toast(files.length === 1 ? 'Foto subida.' : `${files.length} fotos procesadas.`);
  });

  async function saveGalleryOrder(msg) {
    try {
      gallery = (await api('gallerySave', { items: gallery.map(({ id, caption }) => ({ id, caption })) })).gallery;
      if (msg) toast(msg);
    } catch (e) { fail(e); }
  }

  $('#gl-list').addEventListener('change', (ev) => {
    const i = ev.target.dataset.gcap;
    if (i === undefined) return;
    gallery[Number(i)].caption = ev.target.value;
    saveGalleryOrder('Texto guardado.');
  });
  $('#gl-list').addEventListener('click', async (ev) => {
    const mv = ev.target.closest('[data-gmove]');
    if (mv) {
      const i = Number(mv.dataset.i);
      const j = i + Number(mv.dataset.gmove);
      [gallery[i], gallery[j]] = [gallery[j], gallery[i]];
      renderGallery();
      saveGalleryOrder();
      return;
    }
    const del = ev.target.closest('[data-gdel]');
    if (del && confirm('¿Borrar esta foto del sitio?')) {
      try { gallery = (await api('galleryDelete', { id: del.dataset.gdel })).gallery; renderGallery(); toast('Foto borrada.'); } catch (e) { fail(e); }
    }
  });

  // ---------- acciones de edición ----------
  $('#app').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || !S.cfg) return;
    const i = Number(b.dataset.i);
    const c = S.cfg;
    switch (b.dataset.act) {
      case 'add-service':
        c.services.push({ id: rid('s'), name: 'Nuevo servicio', desc: '', price: 0, active: true });
        renderServices();
        $$('#sv-list [data-bind$=".name"]').pop().select();
        break;
      case 'del-service':
        if (!confirm(`¿Borrar "${c.services[i].name}"? Los turnos ya reservados no se tocan.`)) return;
        c.services.splice(i, 1);
        renderServices();
        break;
      case 'up-service':
      case 'down-service': {
        const j = b.dataset.act === 'up-service' ? i - 1 : i + 1;
        if (j < 0 || j >= c.services.length) return;
        [c.services[i], c.services[j]] = [c.services[j], c.services[i]];
        renderServices();
        break;
      }
      case 'add-range': {
        const w = c.schedule.week[b.dataset.day];
        const last = w[w.length - 1];
        const from = last && last.to < '22:00' ? last.to : '16:00';
        const to = toMin(from) + 120 <= 1439 ? `${String(Math.floor((toMin(from) + 120) / 60)).padStart(2, '0')}:${from.slice(3)}` : '23:30';
        w.push({ from, to });
        renderHorarios();
        break;
      }
      case 'del-range':
        c.schedule.week[b.dataset.day].splice(i, 1);
        renderHorarios();
        break;
      case 'add-closed': {
        const v = $('#hr-closed-date').value;
        if (!v) { toast('Elegí una fecha primero.', true); return; }
        if (!c.closedDates.includes(v)) c.closedDates = [...c.closedDates, v].sort();
        $('#hr-closed-date').value = '';
        renderHorarios();
        break;
      }
      case 'del-closed':
        c.closedDates = c.closedDates.filter((d) => d !== b.dataset.date);
        renderHorarios();
        break;
      case 'add-barber':
        c.barbers.push({ id: rid('b'), name: 'Nuevo barbero', active: true });
        renderHorarios();
        $$('#hr-barbers input[data-bind$=".name"]').pop().select();
        break;
      case 'del-barber':
        if (c.barbers.length === 1) return;
        if (!confirm(`¿Borrar a ${c.barbers[i].name}? Sus turnos ya reservados siguen en la agenda.`)) return;
        c.barbers.splice(i, 1);
        renderHorarios();
        break;
      case 'accent':
        c.theme.accent = b.dataset.color;
        renderSitio();
        break;
      default:
        return;
    }
    updateSavebar();
  });

  boot();
})();
