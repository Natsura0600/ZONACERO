(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const dt = (d) => new Date(d + 'T12:00:00Z');
  const fmt = (d, o) => new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', ...o }).format(dt(d)).replace(/\./g, '');
  const longDate = (d) => fmt(d, { weekday: 'long', day: 'numeric', month: 'long' });

  const store = {
    get(k) { try { return localStorage.getItem('zc:' + k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem('zc:' + k, v); } catch { /* sin almacenamiento */ } },
  };

  const SCISSORS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.6 20 18M8.6 16.4 20 6"/></svg>';

  async function api(action, data = {}, method = 'POST') {
    let res;
    try {
      res = method === 'GET'
        ? await fetch('/api/site?' + new URLSearchParams({ action, ...data }))
        : await fetch('/api/site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
    } catch {
      throw new Error('No hay conexión. Revisá internet y probá de nuevo.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || 'Algo falló. Probá de nuevo en un rato.');
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const state = { cfg: null, serviceId: '', barberId: 'any', date: '', time: '', timesReq: 0 };

  // Negro (o casi) = sigue al tema blanco/negro. Cualquier otro color se usa tal cual,
  // con texto blanco o negro según cuál se lea mejor encima.
  function applyAccent(hex) {
    const root = document.documentElement.style;
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 0.02) { root.removeProperty('--accent'); root.removeProperty('--accent-ink'); return; }
    root.setProperty('--accent', hex);
    root.setProperty('--accent-ink', lum > 0.4 ? '#0a0a0a' : '#ffffff');
  }

  // ---------- textos del negocio ----------
  function renderBusiness(cfg) {
    const b = cfg.business;
    document.title = `${b.name}${b.tagline ? ' · ' + b.tagline : ''}`;
    applyAccent(cfg.theme && cfg.theme.accent);

    $('#brand-small').textContent = b.name;
    $('#foot-name').textContent = b.name;
    $('#card-brand').textContent = b.name;
    $('#tagline').textContent = b.tagline || '';
    $('#tagline').hidden = !b.tagline;

    const words = b.name.trim().split(/\s+/);
    $('#hero-name').innerHTML = words.map((w, i) => {
      if (i === words.length - 1 && /[oO0]$/.test(w)) return `<span>${esc(w.slice(0, -1))}<em class="zero">${esc(w.slice(-1))}</em></span>`;
      return `<span>${esc(w)}</span>`;
    }).join('');

    $('#hero-title').textContent = b.heroTitle || '';
    $('#hero-title').hidden = !b.heroTitle;
    $('#hero-text').textContent = b.heroText || '';
    $('#hero-text').hidden = !b.heroText;

    $('#announce-text').textContent = b.announcement || '';
    $('#announce').hidden = !b.announcement;

    $('#about-text').textContent = b.about || '';
    $('#about').hidden = !b.about;

    const links = [];
    if (b.instagram) links.push(`<a href="https://instagram.com/${encodeURIComponent(b.instagram)}" target="_blank" rel="noopener">Instagram @${esc(b.instagram)}</a>`);
    if (b.whatsapp) {
      let d = b.whatsapp.replace(/\D/g, '');
      if (!d.startsWith('54') && d.length === 10) d = '549' + d;
      links.push(`<a href="https://wa.me/${d}" target="_blank" rel="noopener">WhatsApp ${esc(b.whatsapp)}</a>`);
    }
    links.push(`<span>© ${new Date().getFullYear()} ${esc(b.name)}</span>`);
    $('#foot-links').innerHTML = links.join('');

    const l = cfg.loyalty;
    document.querySelectorAll('[data-loyalty]').forEach((el) => { el.hidden = !l.enabled; });
    $('#loyalty-text').textContent = l.text || '';
    $('#loyalty-reward').textContent = l.reward;
    $('#loyalty-goal').textContent = l.goal;
  }

  // ---------- galería ----------
  let photos = [];
  let lbIndex = 0;
  const photoUrl = (id) => `/api/site?action=photo&id=${encodeURIComponent(id)}`;

  function renderGallery(cfg) {
    photos = cfg.gallery || [];
    document.querySelectorAll('[data-gallery]').forEach((el) => { el.hidden = !photos.length; });
    if (!photos.length) return;
    const box = $('#shots');
    box.innerHTML = photos.map((p, i) => `
      <button type="button" class="shot" data-shot="${i}" aria-label="Ver foto${p.caption ? ': ' + esc(p.caption) : ''}">
        <img src="${photoUrl(p.id)}" alt="${esc(p.caption || 'Corte en ' + cfg.business.name)}" loading="${i < 4 ? 'eager' : 'lazy'}" decoding="async" width="${p.w}" height="${p.h}">
        ${p.caption ? `<span class="shot__cap">${esc(p.caption)}</span>` : ''}
      </button>`).join('');
    const old = $('.shots-more');
    if (old) old.remove();
    if (photos.length > 8) {
      box.classList.add('shots--more');
      box.insertAdjacentHTML('afterend', `<div class="shots-more"><button class="btn btn--ghost" type="button" id="shots-more">Ver las ${photos.length} fotos</button></div>`);
      $('#shots-more').addEventListener('click', (ev) => { box.classList.remove('shots--more'); ev.currentTarget.parentElement.remove(); });
    }
  }

  function showPhoto(i) {
    lbIndex = (i + photos.length) % photos.length;
    const p = photos[lbIndex];
    $('#lb-img').src = photoUrl(p.id);
    $('#lb-img').alt = p.caption || 'Foto de un corte';
    $('#lb-cap').textContent = p.caption || '';
    const multi = photos.length > 1;
    document.querySelectorAll('.lb-btn').forEach((b) => { b.hidden = !multi; });
  }

  $('#shots').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-shot]');
    if (!b) return;
    showPhoto(Number(b.dataset.shot));
    $('#lightbox').showModal();
  });
  $('#lightbox').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lb]');
    if (b) {
      if (b.dataset.lb === 'close') $('#lightbox').close(); else showPhoto(lbIndex + Number(b.dataset.lb));
    } else if (ev.target === ev.currentTarget || ev.target.classList.contains('lightbox__fig')) {
      $('#lightbox').close();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (!$('#lightbox').open) return;
    if (ev.key === 'ArrowRight') showPhoto(lbIndex + 1);
    if (ev.key === 'ArrowLeft') showPhoto(lbIndex - 1);
  });
  let touchX = null;
  $('#lightbox').addEventListener('touchstart', (ev) => { touchX = ev.touches[0].clientX; }, { passive: true });
  $('#lightbox').addEventListener('touchend', (ev) => {
    if (touchX === null) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50 && photos.length > 1) showPhoto(lbIndex + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  // ---------- pizarra de precios ----------
  function renderBoard(cfg) {
    const board = $('#board');
    if (!cfg.services.length) {
      board.innerHTML = '<li class="board__row board__row--skeleton">Pronto vas a ver los servicios acá.</li>';
      return;
    }
    board.innerHTML = cfg.services.map((s) => `
      <li class="board__row">
        <button class="board__btn" type="button" data-service="${esc(s.id)}">
          <span class="board__name">${esc(s.name)}</span>
          <span class="board__dots" aria-hidden="true"></span>
          <span class="board__price">${money.format(s.price)}</span>
          <span class="board__desc">${esc(s.desc)}</span>
          <span class="board__go">Reservar →</span>
        </button>
      </li>`).join('');
  }

  // ---------- reserva ----------
  function renderServices() {
    const { services } = state.cfg;
    $('#opt-services').innerHTML = services.length
      ? services.map((s) => `
        <button type="button" class="opt" role="radio" aria-checked="${s.id === state.serviceId}" data-pick-service="${esc(s.id)}">
          <span class="opt__title">${esc(s.name)}</span>
          <span class="opt__meta">${money.format(s.price)}</span>
        </button>`).join('')
      : '<p class="muted">Todavía no hay servicios cargados.</p>';
  }

  function renderBarbers() {
    const { barbers } = state.cfg;
    const show = barbers.length > 1;
    $('#step-barber').hidden = !show;
    const base = show ? 3 : 2;
    $('[data-n="day"]').textContent = base;
    $('[data-n="time"]').textContent = base + 1;
    $('[data-n="data"]').textContent = base + 2;
    if (!show) { state.barberId = 'any'; return; }
    const opts = [{ id: 'any', name: 'El que esté libre' }, ...barbers];
    $('#opt-barbers').innerHTML = opts.map((b) => `
      <button type="button" class="opt opt--chip" role="radio" aria-checked="${b.id === state.barberId}" data-pick-barber="${esc(b.id)}">
        <span class="opt__title">${esc(b.name)}</span>
      </button>`).join('');
  }

  function renderDays() {
    const { days, today } = state.cfg;
    const tomorrow = days[1] && days[1].date;
    $('#opt-days').innerHTML = days.map((d) => {
      const wd = d.date === today ? 'Hoy' : d.date === tomorrow ? 'Mañana' : fmt(d.date, { weekday: 'short' });
      return `
        <button type="button" class="day" role="radio" aria-checked="${d.date === state.date}" data-pick-day="${d.date}" ${d.open ? '' : 'disabled'} aria-label="${esc(longDate(d.date))}${d.open ? '' : ' (cerrado)'}">
          <span class="day__wd">${esc(wd)}</span>
          <span class="day__n">${fmt(d.date, { day: 'numeric' })}</span>
          <span class="day__m">${esc(fmt(d.date, { month: 'short' }))}</span>
        </button>`;
    }).join('');
  }

  async function loadTimes() {
    const box = $('#opt-times');
    if (!state.date) { box.innerHTML = '<p class="muted">Elegí un día para ver los horarios libres.</p>'; return; }
    const req = ++state.timesReq;
    box.innerHTML = '<p class="muted">Buscando horarios libres…</p>';
    try {
      const { times } = await api('slots', { date: state.date, barber: state.barberId }, 'GET');
      if (req !== state.timesReq) return;
      if (!times.includes(state.time)) state.time = '';
      box.innerHTML = times.length
        ? times.map((t) => `<button type="button" class="time" role="radio" aria-checked="${t === state.time}" data-pick-time="${t}">${t}</button>`).join('')
        : '<p class="muted">No quedan horarios libres ese día. Probá con otro.</p>';
    } catch (e) {
      if (req !== state.timesReq) return;
      box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
    updateSummary();
  }

  function updateSummary() {
    const s = state.cfg && state.cfg.services.find((x) => x.id === state.serviceId);
    const parts = [];
    if (s) parts.push(`<b>${esc(s.name)}</b>`);
    if (state.date) parts.push(esc(fmt(state.date, { weekday: 'short', day: 'numeric', month: 'short' })));
    if (state.time) parts.push(`${state.time} h`);
    if (s) parts.push(money.format(s.price));
    $('#summary').innerHTML = parts.length ? parts.join(' · ') : 'Elegí servicio, día y horario.';
    $('#book-btn').disabled = !(s && state.date && state.time);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = !msg;
  }

  function pickService(id, scroll) {
    state.serviceId = id;
    renderServices();
    updateSummary();
    if (scroll) $('#turno').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-service],[data-pick-service],[data-pick-barber],[data-pick-day],[data-pick-time]');
    if (!t || !state.cfg) return;
    if (t.dataset.service) return pickService(t.dataset.service, true);
    if (t.dataset.pickService) return pickService(t.dataset.pickService, false);
    if (t.dataset.pickBarber) {
      state.barberId = t.dataset.pickBarber;
      renderBarbers();
      loadTimes();
      return;
    }
    if (t.dataset.pickDay) {
      state.date = t.dataset.pickDay;
      state.time = '';
      renderDays();
      updateSummary();
      loadTimes();
      return;
    }
    if (t.dataset.pickTime) {
      state.time = t.dataset.pickTime;
      document.querySelectorAll('[data-pick-time]').forEach((b) => b.setAttribute('aria-checked', String(b === t)));
      updateSummary();
    }
  });

  $('#booking-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#book-error');
    const name = $('#f-name').value.trim();
    const phone = $('#f-phone').value.trim();
    if (name.length < 2) { showError(err, 'Escribí tu nombre.'); $('#f-name').focus(); return; }
    if (phone.replace(/\D/g, '').length < 8) { showError(err, 'Escribí tu celular con característica, por ejemplo 11 2345 6789.'); $('#f-phone').focus(); return; }
    showError(err, '');
    const btn = $('#book-btn');
    btn.disabled = true;
    btn.textContent = 'Reservando…';
    try {
      const r = await api('book', {
        serviceId: state.serviceId, barberId: state.barberId, date: state.date, time: state.time, name, phone,
      });
      store.set('name', name);
      store.set('phone', phone);
      const b = r.booking;
      $('#done-detail').textContent = `${b.serviceName} · ${longDate(b.date)} a las ${b.time} h${state.cfg.barbers.length > 1 ? ' con ' + b.barberName : ''}`;
      $('#done-code').textContent = b.code;
      const ds = $('#done-stamps');
      if (r.card && r.card.client) {
        const goal = state.cfg.loyalty.goal;
        const c = r.card.client;
        ds.textContent = c.stamps >= goal
          ? `Tenés el premio disponible: ${state.cfg.loyalty.reward}. Avisale al barbero.`
          : `Llevás ${c.stamps} de ${goal} sellos. Este turno suma uno cuando venís.`;
        ds.hidden = false;
        renderCard(r.card, phone);
      } else ds.hidden = true;
      $('#booking-form').hidden = true;
      $('#booking-done').hidden = false;
      $('#booking-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      showError(err, e.message);
      if (e.status === 409 || e.status === 400) loadTimes();
    } finally {
      btn.textContent = 'Confirmar turno';
      updateSummary();
    }
  });

  $('#book-again').addEventListener('click', () => {
    state.time = '';
    $('#booking-done').hidden = true;
    $('#booking-form').hidden = false;
    loadTimes();
  });

  // ---------- tarjeta ----------
  function renderStamps(stamps, goal) {
    const box = $('#card-stamps');
    const cols = goal <= 10 ? 5 : goal <= 12 ? 6 : goal <= 16 ? 8 : 10;
    box.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const filled = Math.min(stamps, goal);
    let html = '';
    for (let i = 1; i <= goal; i++) {
      const on = i <= filled;
      if (i === goal) html += `<span class="stamp is-prize${on ? ' is-on' : ''}">${on ? SCISSORS : 'Premio'}</span>`;
      else html += `<span class="stamp${on ? ' is-on' : ''}">${on ? SCISSORS : ''}</span>`;
    }
    box.innerHTML = html;
  }

  function renderSample() {
    const goal = state.cfg ? state.cfg.loyalty.goal : 10;
    const n = Math.max(1, Math.round(goal * 0.6));
    renderStamps(n, goal);
    $('#card').classList.add('is-sample');
    $('#card-who').textContent = 'Ejemplo';
    $('#card-count').textContent = `${n} de ${goal}`;
    $('#card-status').textContent = `Te faltan ${goal - n} para el premio`;
  }

  function renderCard(data, phone) {
    const card = $('#card');
    const caption = $('#card-caption');
    const mine = $('#mine');
    if (!data.client) {
      renderStamps(0, state.cfg.loyalty.goal);
      card.classList.remove('is-sample', 'has-prize');
      $('#card-who').textContent = 'Sin sellos todavía';
      $('#card-count').textContent = `0 de ${state.cfg.loyalty.goal}`;
      $('#card-status').textContent = 'Sacá tu primer turno y empezá a sumar';
      caption.textContent = 'No encontramos visitas con ese celular. Tu tarjeta arranca con tu primer turno.';
      mine.hidden = true;
      return;
    }
    const goal = state.cfg.loyalty.goal;
    const c = data.client;
    renderStamps(c.stamps, goal);
    card.classList.remove('is-sample');
    card.classList.toggle('has-prize', c.stamps >= goal);
    $('#card-who').textContent = c.name || 'Tu tarjeta';
    $('#card-count').textContent = `${Math.min(c.stamps, goal)} de ${goal}`;
    $('#card-status').textContent = c.stamps >= goal
      ? `¡Premio listo! ${state.cfg.loyalty.reward}`
      : `Te ${goal - c.stamps === 1 ? 'falta 1' : 'faltan ' + (goal - c.stamps)} para el premio`;
    caption.textContent = c.visits ? `${c.visits} ${c.visits === 1 ? 'visita' : 'visitas'} en total${c.rewards ? ` · ${c.rewards} ${c.rewards === 1 ? 'premio canjeado' : 'premios canjeados'}` : ''}.` : 'Los sellos se suman cuando venís a cortarte.';

    mine.hidden = false;
    mine.dataset.phone = phone;
    $('#mine-list').innerHTML = data.upcoming.length
      ? data.upcoming.map((b) => `
        <li class="mine__item">
          <div class="mine__head">
            <div>
              <div class="mine__when">${esc(fmt(b.date, { weekday: 'long', day: 'numeric', month: 'short' }))} · ${esc(b.time)} h</div>
              <div class="mine__what">${esc(b.serviceName)}${state.cfg.barbers.length > 1 ? ' · ' + esc(b.barberName) : ''}</div>
            </div>
            <button type="button" class="link-btn" data-cancel-open>Cancelar</button>
          </div>
          <form class="mine__cancel" data-cancel-form hidden>
            <input maxlength="8" placeholder="Código" aria-label="Código del turno" autocomplete="off">
            <button class="btn btn--accent" type="submit">Cancelar turno</button>
          </form>
        </li>`).join('')
      : '<li class="mine__empty">No tenés turnos reservados.</li>';
  }

  $('#lookup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#lookup-error');
    const phone = $('#l-phone').value.trim();
    if (phone.replace(/\D/g, '').length < 8) { showError(err, 'Escribí tu celular con característica, por ejemplo 11 2345 6789.'); return; }
    showError(err, '');
    const btn = ev.submitter || $('#lookup-form button');
    btn.disabled = true;
    try {
      const data = await api('lookup', { phone });
      store.set('phone', phone);
      renderCard(data, phone);
    } catch (e) {
      showError(err, e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#mine-list').addEventListener('click', (ev) => {
    const open = ev.target.closest('[data-cancel-open]');
    if (!open) return;
    const form = open.closest('.mine__item').querySelector('[data-cancel-form]');
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input').focus();
  });

  $('#mine-list').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target.closest('[data-cancel-form]');
    if (!form) return;
    const code = form.querySelector('input').value.trim();
    const err = $('#lookup-error');
    if (!code) { showError(err, 'Escribí el código que te dimos al reservar.'); return; }
    const phone = $('#mine').dataset.phone;
    try {
      const data = await api('cancel', { phone, code });
      showError(err, '');
      renderCard(data, phone);
      if (state.date) loadTimes();
    } catch (e) {
      showError(err, e.message);
    }
  });

  // ---------- arranque ----------
  async function init() {
    const savedName = store.get('name');
    const savedPhone = store.get('phone');
    if (savedName) $('#f-name').value = savedName;
    if (savedPhone) { $('#f-phone').value = savedPhone; $('#l-phone').value = savedPhone; }
    renderStamps(6, 10);

    try {
      state.cfg = await api('config', {}, 'GET');
    } catch (e) {
      $('#booking-panel').innerHTML = `<p class="muted">Las reservas online no están disponibles en este momento. ${e.status === 503 ? '' : esc(e.message)}</p>`;
      $('#lookup-form').hidden = true;
      return;
    }
    const cfg = state.cfg;
    renderBusiness(cfg);
    renderBoard(cfg);
    renderGallery(cfg);
    renderServices();
    renderBarbers();
    const first = cfg.days.find((d) => d.open);
    state.date = first ? first.date : '';
    renderDays();
    renderSample();
    updateSummary();
    loadTimes();
  }

  init();
})();
