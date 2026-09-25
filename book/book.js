// /book: client booking flow. Talks to the Apps Script web app in notes/booking/Code.gs.
//   GET  ?action=config                       → meeting types, business hours, limits
//   GET  ?action=slots&from=&to=&type=        → ISO start times that are open (UTC)
//   POST {action:'book', ...} as text/plain   → creates the calendar event, sends emails
// All dates are handled in the visitor's chosen time zone via Intl; the server owns the
// business-hours rules in Pacific time, so this file never needs to know them.
(function () {
  'use strict';

  const root = document.getElementById('book');
  const API = root.dataset.api;
  const $ = id => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    });
    kids.flat().forEach(k => { if (k != null) n.append(k.nodeType ? k : document.createTextNode(k)); });
    return n;
  };

  const state = {
    config: null,
    type: null,                    // selected meeting type object
    tz: guessTz(),
    view: null,                    // {y, m} month being shown, in state.tz
    selectedDay: null,             // 'YYYY-MM-DD' in state.tz
    slot: null,                    // ISO string
    slotCache: new Map(),          // key `${type}|${from}|${to}` → ISO[]
    loading: 0,
  };

  // ————— time zone helpers —————
  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'; } catch (_) { return 'America/Los_Angeles'; }
  }
  function partsIn(date, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    const o = {};
    f.formatToParts(date).forEach(p => { if (p.type !== 'literal') o[p.type] = Number(p.value); });
    return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute };
  }
  const pad = n => String(n).padStart(2, '0');
  const ymd = p => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const dayKey = (date, tz) => ymd(partsIn(date, tz));
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // calendar weekday is zone-independent
  const fmtTime = (date, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
  const fmtLong = (date, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  const fmtMonth = (y, m) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
  const tzShort = tz => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value; } catch (_) { return tz; }
  };
  const ymdShift = (key, days) => { const [y, m, d] = key.split('-').map(Number); return dayKey(new Date(Date.UTC(y, m - 1, d + days, 12)), 'UTC'); };

  function tzOptions() {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { /* older browsers */ }
    const common = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
    const set = new Set([state.tz, ...common, ...zones]);
    return [...set];
  }

  // ————— API —————
  async function api(params) {
    const url = API + (API.includes('?') ? '&' : '?') + new URLSearchParams(params);
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  async function post(payload) {
    // text/plain keeps this a "simple" request (no preflight), which Apps Script requires.
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const data = await res.json();
    return data;
  }

  // Open slots covering a visitor-month, grouped by visitor-local day. The server's
  // range is in Pacific dates, so ask for one extra day on each side to cover the offset.
  async function slotsForView() {
    const { y, m } = state.view;
    const from = ymdShift(`${y}-${pad(m)}-01`, -1);
    const to = ymdShift(`${y}-${pad(m)}-${pad(daysInMonth(y, m))}`, 1);
    const key = `${state.type.id}|${from}|${to}`;
    if (!state.slotCache.has(key)) {
      const data = await api({ action: 'slots', from, to, type: state.type.id });
      state.slotCache.set(key, data.slots);
    }
    const byDay = new Map();
    state.slotCache.get(key).forEach(iso => {
      const k = dayKey(new Date(iso), state.tz);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(iso);
    });
    return byDay;
  }

  // ————— steps —————
  function showStep(n) {
    document.querySelectorAll('.panel').forEach(p => { p.hidden = Number(p.dataset.panel) !== n; });
    document.querySelectorAll('.step').forEach(s => {
      const k = Number(s.dataset.step);
      s.classList.toggle('active', k === n);
      s.classList.toggle('done', k < n);
    });
    $('global-error').hidden = true;
    const panel = document.querySelector(`.panel[data-panel="${n}"]`);
    if (panel && n > 1) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function fail(msg) { $('global-error').textContent = msg; $('global-error').hidden = false; }

  // Step 1
  function renderTypes() {
    const wrap = $('types');
    wrap.replaceChildren();
    state.config.types.forEach(t => {
      wrap.append(el('button', { class: 'type', type: 'button', role: 'listitem', onclick: () => chooseType(t) },
        el('span', { class: 'eyebrow', text: `${t.minutes} minutes · Google Meet` }),
        el('h2', { text: t.name }),
        el('p', { text: t.blurb }),
        el('span', { class: 'arrow', text: 'Pick a time →' })
      ));
    });
  }
  function chooseType(t) {
    state.type = t;
    state.slot = null;
    state.selectedDay = null;
    const p = partsIn(new Date(), state.tz);
    state.view = { y: p.y, m: p.m };
    history.replaceState(null, '', `?type=${encodeURIComponent(t.id)}`);
    showStep(2);
    renderCalendar();
  }

  // Step 2
  async function renderCalendar() {
    const { y, m } = state.view;
    const grid = $('cal-grid');
    const note = $('cal-note');
    $('cal-title').textContent = fmtMonth(y, m);
    const now = partsIn(new Date(), state.tz);
    const maxKey = dayKey(new Date(Date.now() + state.config.maxDaysAhead * 86400e3), state.tz);
    $('prev-month').disabled = (y < now.y) || (y === now.y && m <= now.m);
    $('next-month').disabled = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` >= maxKey;

    grid.replaceChildren(...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => el('div', { class: 'dow', role: 'columnheader', text: d })));
    for (let i = 0; i < weekdayOf(y, m, 1); i++) grid.append(el('div', { class: 'day blank' }));
    const cells = [];
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;
      const cell = el('button', { class: 'day', type: 'button', disabled: '', 'data-day': key, 'aria-label': fmtLong(new Date(Date.UTC(y, m - 1, d, 12)), 'UTC'), text: String(d) });
      if (key === ymd(now)) cell.classList.add('today');
      cells.push(cell);
      grid.append(cell);
    }
    note.textContent = 'Checking the calendar…';
    let byDay;
    try {
      byDay = await slotsForView();
    } catch (err) {
      note.textContent = '';
      fail('Couldn’t load availability. Refresh to try again, or email jared@jaredbfries.com.');
      return;
    }
    if (state.view.y !== y || state.view.m !== m) return; // user moved on while loading
    let openCount = 0;
    cells.forEach(cell => {
      const key = cell.dataset.day;
      if (byDay.has(key)) {
        openCount++;
        cell.disabled = false;
        cell.classList.add('open');
        cell.addEventListener('click', () => selectDay(key, byDay.get(key)));
      }
    });
    note.textContent = openCount ? `${openCount} day${openCount === 1 ? '' : 's'} with openings this month. Times shown in ${tzShort(state.tz)}.` : 'No openings this month. Try the next one.';
    if (state.selectedDay && byDay.has(state.selectedDay)) selectDay(state.selectedDay, byDay.get(state.selectedDay));
    else if (state.selectedDay) { state.selectedDay = null; $('times-title').textContent = 'Pick a day'; $('slot-list').replaceChildren(); }
  }

  function selectDay(key, slots) {
    state.selectedDay = key;
    document.querySelectorAll('.day').forEach(d => d.classList.toggle('selected', d.dataset.day === key));
    const [y, m, d] = key.split('-').map(Number);
    $('times-title').textContent = fmtLong(new Date(Date.UTC(y, m - 1, d, 12)), 'UTC');
    const list = $('slot-list');
    list.replaceChildren();
    if (!slots.length) { list.append(el('p', { class: 'empty', text: 'Nothing open that day.' })); return; }
    slots.forEach(iso => {
      const start = new Date(iso);
      list.append(el('button', { class: 'slot', type: 'button', onclick: () => chooseSlot(iso) },
        el('span', { text: fmtTime(start, state.tz) }),
        el('span', { class: 'go', text: 'Select →' })
      ));
    });
  }

  function chooseSlot(iso) {
    state.slot = iso;
    renderSummary();
    showStep(3);
    setTimeout(() => $('name').focus(), 350);
  }

  // Step 3
  function renderSummary() {
    const start = new Date(state.slot);
    const end = new Date(start.getTime() + state.type.minutes * 60e3);
    $('summary').replaceChildren(
      el('div', {}, el('div', { class: 'k', text: 'Meeting' }), el('div', { class: 'v big', text: state.type.name }), el('div', { class: 'v', text: `${state.type.minutes} minutes · Google Meet` })),
      el('div', {}, el('div', { class: 'k', text: 'When' }), el('div', { class: 'v', text: fmtLong(start, state.tz) }), el('div', { class: 'v', text: `${fmtTime(start, state.tz)} – ${fmtTime(end, state.tz)} ${tzShort(state.tz)}` })),
      el('div', {}, el('div', { class: 'k', text: 'With' }), el('div', { class: 'v', text: state.config.ownerName }))
    );
  }

  async function submit(ev) {
    ev.preventDefault();
    const form = $('book-form');
    const errEl = $('form-error');
    const btn = $('confirm-btn');
    errEl.hidden = true;
    form.querySelectorAll('.field-error').forEach(f => f.classList.remove('field-error'));
    const name = $('name').value.trim();
    const email = $('email').value.trim();
    const problems = [];
    if (!name) { problems.push('your name'); $('name').parentElement.classList.add('field-error'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { problems.push('a working email'); $('email').parentElement.classList.add('field-error'); }
    if (problems.length) { errEl.textContent = 'Please add ' + problems.join(' and ') + '.'; errEl.hidden = false; return; }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Booking…';
    try {
      const data = await post({
        action: 'book',
        type: state.type.id,
        start: state.slot,
        name, email,
        organization: $('org').value.trim(),
        notes: $('notes').value.trim(),
        tz: state.tz,
        website: $('website').value,
        ts: loadedAt,
        page: location.pathname,
      });
      if (!data.ok) {
        if (data.code === 'taken') {
          state.slotCache.clear();
          state.slot = null;
          showStep(2);
          fail(data.error);
          renderCalendar();
          return;
        }
        throw new Error(data.error || 'Booking failed.');
      }
      renderDone(data.booking);
      showStep(4);
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Something went wrong. Try again, or email jared@jaredbfries.com.';
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // Step 4
  function renderDone(b) {
    const start = new Date(b.start), end = new Date(b.end);
    const email = $('email').value.trim();
    const box = $('done');
    box.replaceChildren(
      el('h2', { text: `See you ${fmtLong(start, state.tz).split(',')[0]}, ${$('name').value.trim().split(' ')[0]}.` }),
      el('div', { class: 'card' },
        el('div', {}, el('div', { class: 'k', text: 'Meeting' }), el('div', { text: `${b.type} · ${b.minutes} minutes` })),
        el('div', {}, el('div', { class: 'k', text: 'When' }), el('div', { text: `${fmtLong(start, state.tz)}` }), el('div', { text: `${fmtTime(start, state.tz)} – ${fmtTime(end, state.tz)} ${tzShort(state.tz)}` })),
        el('div', {}, el('div', { class: 'k', text: 'Where' }), b.meetLink ? el('a', { href: b.meetLink, text: 'Google Meet' }) : el('div', { text: 'Google Meet (link is in your calendar invite)' })),
      ),
      el('p', { class: 'next' }, 'A Google Calendar invitation and a confirmation email are on their way to ', el('b', { text: email }), '. Accept the invite and it lands on your calendar with a reminder. Need to change it? The confirmation email has a cancel link, or just reply to it.'),
      el('div', { class: 'actions' },
        el('a', { class: 'cta ghost', href: '/', text: 'Back to the site' }),
        b.cancelUrl ? el('a', { class: 'back', href: b.cancelUrl, text: 'Cancel this meeting' }) : null
      )
    );
  }

  // ————— wiring —————
  const loadedAt = Date.now();
  $('prev-month').addEventListener('click', () => { const v = state.view; state.view = v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 }; renderCalendar(); });
  $('next-month').addEventListener('click', () => { const v = state.view; state.view = v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 }; renderCalendar(); });
  document.querySelectorAll('.back').forEach(b => b.addEventListener('click', () => showStep(Number(b.dataset.back))));
  $('book-form').addEventListener('submit', submit);

  const tzSel = $('tz');
  tzOptions().forEach(z => tzSel.append(el('option', { value: z, text: `${z.replace(/_/g, ' ')} (${tzShort(z)})` })));
  tzSel.value = state.tz;
  tzSel.addEventListener('change', () => {
    state.tz = tzSel.value;
    if (state.view) { const p = partsIn(new Date(), state.tz); if (!state.selectedDay) state.view = { y: p.y, m: p.m }; renderCalendar(); }
  });

  (async function init() {
    if (!API || API.includes('APPS_SCRIPT_DEPLOYMENT_ID')) {
      $('types-loading').textContent = 'Booking isn’t switched on yet. Email jared@jaredbfries.com to set up a call.';
      return;
    }
    try {
      state.config = (await api({ action: 'config' })).config;
    } catch (err) {
      $('types-loading').textContent = 'Couldn’t reach the calendar. Refresh to try again, or email jared@jaredbfries.com.';
      return;
    }
    renderTypes();
    const want = new URLSearchParams(location.search).get('type');
    const pre = state.config.types.find(t => t.id === want);
    if (pre) chooseType(pre); else showStep(1);
  })();
})();
