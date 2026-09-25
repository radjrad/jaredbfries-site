// Booking backend for jaredbfries.com/book.
// A standalone Google Apps Script deployed as a Web app (Execute as: Me, Who has access: Anyone).
// It reads busy time from Jared's Google Calendar, serves open slots, books meetings
// (client is added as a guest so Google sends them the calendar invite), and emails
// confirmations. Setup and cutover checklist: README.md in this folder.
// Every edit needs Deploy > Manage deployments > edit > New version, or the live
// /exec URL keeps serving the old code.

// ———————————————————————————— config ————————————————————————————

const TZ = 'America/Los_Angeles';        // Jared's time zone; business hours below are in this zone
const OWNER_NAME = 'Jared B. Fries';
const OWNER_EMAIL = 'fries.jared@gmail.com'; // the Gmail account that owns the calendar (see contact-form README on why not the alias)
const REPLY_TO = 'jared@jaredbfries.com';
const SITE_URL = 'https://jaredbfries.com';

// Calendars whose events count as busy. 'primary' is the default calendar of the
// account that deploys the script. Add other calendar IDs (e.g. a shared work
// calendar) and they will be read too.
const BUSY_CALENDAR_IDS = ['primary'];
// Calendar the booked meeting is written to.
const BOOKING_CALENDAR_ID = 'primary';

// Standard business hours, one entry per weekday (0 = Sunday … 6 = Saturday).
// Times are 24h "HH:MM" in TZ. Leave a day out to block it entirely.
const HOURS = {
  1: [['09:00', '17:00']],
  2: [['09:00', '17:00']],
  3: [['09:00', '17:00']],
  4: [['09:00', '17:00']],
  5: [['09:00', '17:00']],
};

const MEETING_TYPES = {
  intro: {
    name: 'Intro call',
    minutes: 30,
    blurb: 'Tell me about your mess. We’ll find out whether I can help and what a calmer version looks like.',
  },
  working: {
    name: 'Working session',
    minutes: 60,
    blurb: 'For current clients. Bring the process, the spreadsheet, or the tool we’re untangling.',
  },
};
const DEFAULT_TYPE = 'intro';

const SLOT_STEP_MINUTES = 30;   // slots start every 30 min
const BUFFER_MINUTES = 15;      // breathing room before and after any existing event
const MIN_NOTICE_HOURS = 4;     // earliest bookable slot is this far in the future
const MAX_DAYS_AHEAD = 60;      // how far out the calendar opens
const ALL_DAY_EVENTS_BLOCK = true; // treat all-day events (vacation, holidays) as busy
const ADD_MEET_LINK = true;     // needs the Calendar advanced service enabled (README step 4)

const HONEYPOT_FIELD = 'website';
const MIN_SECONDS_ON_PAGE = 3;

// Optional: log every booking as a row in a Google Sheet. Leave blank to skip.
const BOOKINGS_SHEET_ID = '';
const BOOKINGS_SHEET_TAB = 'Bookings';

// ———————————————————————————— routing ————————————————————————————

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'config': return json({ ok: true, config: publicConfig() });
      case 'slots':  return json({ ok: true, tz: TZ, slots: availableSlots(p.from, p.to, p.type) });
      case 'cancel': return cancelPage(p.e, p.t);
      default:       return ContentService.createTextOutput('ok');
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const p = parseBody(e);
    if (p[HONEYPOT_FIELD]) return json({ ok: true, spam: true }); // bots learn nothing
    const loaded = Number(p.ts || 0);
    if (loaded && (Date.now() - loaded) / 1000 < MIN_SECONDS_ON_PAGE) return json({ ok: true, spam: true });
    if (p.action !== 'book') return json({ ok: false, error: 'unknown action' });
    return json(book(p));
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function parseBody(e) {
  // The page POSTs JSON as text/plain so the browser sends it without a CORS preflight,
  // which Apps Script cannot answer. Form-encoded posts (curl -d) still work.
  const raw = e && e.postData && e.postData.contents;
  if (raw) { try { return JSON.parse(raw); } catch (_) { /* fall through */ } }
  return (e && e.parameter) || {};
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function publicConfig() {
  return {
    tz: TZ,
    ownerName: OWNER_NAME,
    defaultType: DEFAULT_TYPE,
    types: Object.keys(MEETING_TYPES).map(k => ({ id: k, name: MEETING_TYPES[k].name, minutes: MEETING_TYPES[k].minutes, blurb: MEETING_TYPES[k].blurb })),
    hours: HOURS,
    minNoticeHours: MIN_NOTICE_HOURS,
    maxDaysAhead: MAX_DAYS_AHEAD,
    slotStepMinutes: SLOT_STEP_MINUTES,
  };
}

// ———————————————————————————— availability ————————————————————————————

// Returns ISO timestamps (UTC) for every bookable slot start between two YYYY-MM-DD dates (inclusive, in TZ).
function availableSlots(fromStr, toStr, typeId) {
  const type = MEETING_TYPES[typeId] || MEETING_TYPES[DEFAULT_TYPE];
  const now = new Date();
  const earliest = new Date(now.getTime() + MIN_NOTICE_HOURS * 3600e3);
  const latest = new Date(now.getTime() + MAX_DAYS_AHEAD * 86400e3);

  const from = parseYmd(fromStr) || ymdParts(now);
  const to = parseYmd(toStr) || from;
  const rangeStart = zoned(from.y, from.m, from.d, 0, 0);
  const rangeEnd = zoned(to.y, to.m, to.d + 1, 0, 0);
  if (rangeEnd.getTime() - rangeStart.getTime() > 45 * 86400e3) throw new Error('range too large');

  const busy = busyIntervals(new Date(rangeStart.getTime() - 86400e3), new Date(rangeEnd.getTime() + 86400e3));
  const slots = [];
  const stepMs = SLOT_STEP_MINUTES * 60e3;
  const lenMs = type.minutes * 60e3;

  for (let cur = new Date(rangeStart); cur < rangeEnd; cur = zoned(ymdParts(cur).y, ymdParts(cur).m, ymdParts(cur).d + 1, 0, 0)) {
    const parts = ymdParts(cur);
    const windows = HOURS[parts.dow] || [];
    windows.forEach(w => {
      const open = zoned(parts.y, parts.m, parts.d, hm(w[0]).h, hm(w[0]).m);
      const close = zoned(parts.y, parts.m, parts.d, hm(w[1]).h, hm(w[1]).m);
      for (let s = open.getTime(); s + lenMs <= close.getTime(); s += stepMs) {
        if (s < earliest.getTime() || s > latest.getTime()) continue;
        if (isFree(s, s + lenMs, busy)) slots.push(new Date(s).toISOString());
      }
    });
  }
  return slots;
}

function isFree(startMs, endMs, busy) {
  const pad = BUFFER_MINUTES * 60e3;
  for (let i = 0; i < busy.length; i++) {
    if (startMs - pad < busy[i][1] && endMs + pad > busy[i][0]) return false;
  }
  return true;
}

// [startMs, endMs] pairs for every event that should block a slot.
function busyIntervals(start, end) {
  const out = [];
  BUSY_CALENDAR_IDS.forEach(id => {
    const cal = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
    if (!cal) return;
    cal.getEvents(start, end).forEach(ev => {
      try {
        if (ev.getMyStatus && ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; // declined: not busy
      } catch (_) { /* owner-created events throw on getMyStatus in some cases; treat as busy */ }
      if (ev.isAllDayEvent()) {
        if (!ALL_DAY_EVENTS_BLOCK) return;
        // all-day events arrive at midnight in the script's zone; re-anchor to TZ midnight
        const s = ymdParts(new Date(ev.getAllDayStartDate().getTime() + 12 * 3600e3));
        const e = ymdParts(new Date(ev.getAllDayEndDate().getTime() + 12 * 3600e3));
        out.push([zoned(s.y, s.m, s.d, 0, 0).getTime(), zoned(e.y, e.m, e.d, 0, 0).getTime()]);
        return;
      }
      out.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]);
    });
  });
  return out;
}

// ———————————————————————————— booking ————————————————————————————

function book(p) {
  const type = MEETING_TYPES[p.type] || MEETING_TYPES[DEFAULT_TYPE];
  const name = clean(p.name, 120);
  const email = clean(p.email, 200).toLowerCase();
  const org = clean(p.organization, 200);
  const notes = clean(p.notes, 2000);
  const guestTz = clean(p.tz, 80) || TZ;
  const start = new Date(p.start);
  if (!name) return { ok: false, error: 'Please add your name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'That email address doesn’t look right.' };
  if (isNaN(start.getTime())) return { ok: false, error: 'Pick a time first.' };
  const end = new Date(start.getTime() + type.minutes * 60e3);

  // Serialize bookings so two people can't take the same slot in the same second.
  const lock = LockService.getScriptLock();
  lock.waitLock(20e3);
  try {
    const day = ymdParts(start);
    const dayStr = ymd(day);
    const stillOpen = availableSlots(dayStr, dayStr, p.type).indexOf(start.toISOString()) !== -1;
    if (!stillOpen) return { ok: false, error: 'That time was just taken or is no longer available. Please pick another.', code: 'taken' };

    const cal = BOOKING_CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(BOOKING_CALENDAR_ID);
    const title = `${type.name}: ${name}${org ? ' (' + org + ')' : ''} & ${OWNER_NAME}`;
    const description = [
      `${type.name} booked through ${SITE_URL}/book.`,
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      org ? `Organization: ${org}` : null,
      notes ? `\nNotes:\n${notes}` : null,
    ].filter(v => v !== null).join('\n');

    const event = cal.createEvent(title, start, end, { description, guests: email, sendInvites: true });
    event.setGuestsCanModify(false);
    event.addPopupReminder(10);
    let meetLink = '';
    if (ADD_MEET_LINK) meetLink = addMeetLink(event.getId());

    const cancelUrl = `${ScriptApp.getService().getUrl()}?action=cancel&e=${encodeURIComponent(event.getId())}&t=${cancelToken(event.getId())}`;
    const details = { type, name, email, org, notes, start, end, guestTz, meetLink, cancelUrl, title };
    sendGuestConfirmation(details);
    sendOwnerNotification(details);
    logBooking(details, event.getId());

    return {
      ok: true,
      booking: { id: event.getId(), title, start: start.toISOString(), end: end.toISOString(), type: type.name, minutes: type.minutes, meetLink, cancelUrl },
    };
  } finally {
    lock.releaseLock();
  }
}

// Adds a Google Meet room via the Calendar advanced service, if it is enabled. Returns the link or ''.
function addMeetLink(eventId) {
  try {
    if (typeof Calendar === 'undefined') return '';
    const id = eventId.replace(/@google\.com$/, '');
    const patched = Calendar.Events.patch(
      { conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } },
      BOOKING_CALENDAR_ID, id, { conferenceDataVersion: 1, sendUpdates: 'none' }
    );
    return (patched.hangoutLink) || ((patched.conferenceData || {}).entryPoints || []).filter(e => e.entryPointType === 'video').map(e => e.uri)[0] || '';
  } catch (err) {
    console.warn('Meet link not added: ' + err);
    return '';
  }
}

// ———————————————————————————— cancel ————————————————————————————

function cancelToken(eventId) {
  const secret = scriptSecret();
  const sig = Utilities.computeHmacSha256Signature(eventId, secret);
  return sig.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 32);
}

function scriptSecret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('CANCEL_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('CANCEL_SECRET', s); }
  return s;
}

function cancelPage(eventId, token) {
  let msg;
  if (!eventId || !token || token !== cancelToken(eventId)) {
    msg = 'That cancel link isn’t valid. Email ' + REPLY_TO + ' and I’ll sort it out.';
  } else {
    const cal = BOOKING_CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(BOOKING_CALENDAR_ID);
    const ev = cal.getEventById(eventId);
    if (!ev) {
      msg = 'This meeting was already cancelled.';
    } else {
      const when = fmt(ev.getStartTime(), TZ);
      const guests = ev.getGuestList().map(g => g.getEmail());
      ev.deleteEvent();
      MailApp.sendEmail({
        to: OWNER_EMAIL,
        subject: 'Cancelled: ' + ev.getTitle(),
        body: `${ev.getTitle()}\n${when}\nGuests: ${guests.join(', ')}\n\nCancelled through the link in the confirmation email.`,
      });
      msg = 'Done. Your meeting on ' + when + ' is cancelled. Want a different time? <a href="' + SITE_URL + '/book">Pick a new one</a>.';
    }
  }
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancel meeting | ${OWNER_NAME}</title>
<style>body{font-family:Karla,system-ui,sans-serif;background:#f6f4ed;color:#26302b;margin:0;padding:48px 24px;line-height:1.6}main{max-width:520px;margin:0 auto}h1{font-family:Georgia,serif;font-weight:400;font-size:28px}a{color:#c98a1b}</style></head>
<body><main><h1>${OWNER_NAME}</h1><p>${msg}</p></main></body></html>`;
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY);
}

// ———————————————————————————— email ————————————————————————————

function sendGuestConfirmation(d) {
  const whenGuest = fmt(d.start, d.guestTz) + ' – ' + fmtTime(d.end, d.guestTz) + ' (' + tzLabel(d.guestTz) + ')';
  const whenOwner = d.guestTz !== TZ ? fmt(d.start, TZ) + ' (' + tzLabel(TZ) + ')' : '';
  const lines = [
    `Hi ${d.name.split(' ')[0]},`,
    '',
    `You're booked. Here are the details:`,
    '',
    `What: ${d.type.name} (${d.type.minutes} min) with ${OWNER_NAME}`,
    `When: ${whenGuest}`,
    whenOwner ? `      ${whenOwner}` : null,
    d.meetLink ? `Where: Google Meet, ${d.meetLink}` : `Where: Google Meet (link is in the calendar invite)`,
    '',
    `A Google Calendar invitation is on its way to ${d.email}. Accept it and the meeting lands on your calendar with a reminder.`,
    '',
    `Need to reschedule? Cancel here and pick a new time: ${d.cancelUrl}`,
    `Or just reply to this email.`,
    '',
    `Talk soon,`,
    OWNER_NAME,
    SITE_URL,
  ].filter(v => v !== null);
  const html = `
<div style="font-family:Karla,system-ui,sans-serif;color:#26302b;max-width:560px;line-height:1.6">
  <p>Hi ${esc(d.name.split(' ')[0])},</p>
  <p>You're booked. Here are the details:</p>
  <table cellpadding="0" cellspacing="0" style="border:1px solid #d8d4c5;border-radius:6px;background:#f6f4ed;padding:16px 18px;width:100%">
    <tr><td style="padding:4px 0"><b>What</b></td><td style="padding:4px 0 4px 16px">${esc(d.type.name)} (${d.type.minutes} min) with ${esc(OWNER_NAME)}</td></tr>
    <tr><td style="padding:4px 0;vertical-align:top"><b>When</b></td><td style="padding:4px 0 4px 16px">${esc(whenGuest)}${whenOwner ? '<br><span style="color:#5d6f57">' + esc(whenOwner) + '</span>' : ''}</td></tr>
    <tr><td style="padding:4px 0"><b>Where</b></td><td style="padding:4px 0 4px 16px">${d.meetLink ? '<a href="' + esc(d.meetLink) + '" style="color:#c98a1b">Google Meet</a>' : 'Google Meet (link is in the calendar invite)'}</td></tr>
  </table>
  <p>A Google Calendar invitation is on its way to ${esc(d.email)}. Accept it and the meeting lands on your calendar with a reminder.</p>
  <p style="color:#5d6f57;font-size:14px">Need to reschedule? <a href="${esc(d.cancelUrl)}" style="color:#c98a1b">Cancel this meeting</a> and pick a new time, or just reply to this email.</p>
  <p>Talk soon,<br>${esc(OWNER_NAME)}<br><a href="${SITE_URL}" style="color:#c98a1b">${SITE_URL.replace(/^https?:\/\//, '')}</a></p>
</div>`;
  MailApp.sendEmail({
    to: d.email,
    replyTo: REPLY_TO,
    name: OWNER_NAME,
    subject: `Confirmed: ${d.type.name} with ${OWNER_NAME}, ${fmt(d.start, d.guestTz)}`,
    body: lines.join('\n'),
    htmlBody: html,
  });
}

function sendOwnerNotification(d) {
  MailApp.sendEmail({
    to: OWNER_EMAIL,
    replyTo: d.email,
    subject: `New booking: ${d.name}${d.org ? ' (' + d.org + ')' : ''}, ${d.type.name} ${fmt(d.start, TZ)}`,
    body: [
      `${d.type.name} (${d.type.minutes} min)`,
      `When: ${fmt(d.start, TZ)} – ${fmtTime(d.end, TZ)} ${tzLabel(TZ)}`,
      `Who: ${d.name} <${d.email}>${d.org ? ', ' + d.org : ''}`,
      `Their time zone: ${d.guestTz}`,
      d.meetLink ? `Meet: ${d.meetLink}` : `Meet: not added (enable the Calendar advanced service)`,
      '',
      d.notes ? `Notes:\n${d.notes}` : '(no notes)',
      '',
      `Cancel link (also sent to them): ${d.cancelUrl}`,
    ].join('\n'),
  });
}

function logBooking(d, eventId) {
  if (!BOOKINGS_SHEET_ID) return;
  try {
    const sheet = SpreadsheetApp.openById(BOOKINGS_SHEET_ID).getSheetByName(BOOKINGS_SHEET_TAB);
    if (sheet) sheet.appendRow([new Date(), d.name, d.email, d.org, d.type.name, d.start, d.end, d.guestTz, d.notes, d.meetLink, eventId]);
  } catch (err) {
    console.warn('Booking not logged: ' + err);
  }
}

// ———————————————————————————— date helpers ————————————————————————————
// Everything here is independent of the script project's own time zone setting.

function tzOffsetMs(date, tz) {
  const z = Utilities.formatDate(date, tz || TZ, 'Z'); // e.g. -0700
  const sign = z[0] === '-' ? -1 : 1;
  return sign * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * 60e3;
}

// Date for wall-clock time y-m-d h:mi in TZ (month is 1-based; d may overflow, e.g. d+1).
function zoned(y, m, d, h, mi) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  let off = tzOffsetMs(new Date(guess));
  guess = Date.UTC(y, m - 1, d, h, mi) - off;
  const off2 = tzOffsetMs(new Date(guess));
  if (off2 !== off) guess = Date.UTC(y, m - 1, d, h, mi) - off2;
  return new Date(guess);
}

function ymdParts(date) {
  const s = Utilities.formatDate(date, TZ, 'yyyy-MM-dd-u'); // u = day of week, 1 = Monday … 7 = Sunday
  const [y, m, d, u] = s.split('-').map(Number);
  return { y, m, d, dow: u % 7 };
}
function ymd(p) { return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
function hm(s) { const [h, m] = s.split(':').map(Number); return { h, m }; }

function fmt(date, tz) { return Utilities.formatDate(date, tz, "EEEE, MMMM d, yyyy 'at' h:mm a"); }
function fmtTime(date, tz) { return Utilities.formatDate(date, tz, 'h:mm a'); }
function tzLabel(tz) { return Utilities.formatDate(new Date(), tz, 'zzz') + ', ' + tz.replace(/_/g, ' '); }

function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ———————————————————————————— manual checks (run from the editor) ————————————————————————————

function testSlots() {
  const today = ymd(ymdParts(new Date()));
  const week = ymd(ymdParts(new Date(Date.now() + 7 * 86400e3)));
  const slots = availableSlots(today, week, DEFAULT_TYPE);
  console.log(slots.length + ' slots in the next week; first few:\n' + slots.slice(0, 8).map(s => fmt(new Date(s), TZ)).join('\n'));
}
