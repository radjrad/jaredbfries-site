# Booking page: Google Apps Script + Google Calendar

`/book` is a self-hosted Calendly. Clients pick a meeting type and a time inside
standard business hours (Mon–Fri, 9–5 Pacific), shown in their own time zone.
The page talks to a Google Apps Script web app that:

- reads busy time from Jared's Google Calendar, so anything already on the
  calendar (meetings, holidays, all-day blocks) is never offered,
- creates the event on Jared's calendar with the client as a guest, so Google
  sends them a real calendar invite (with a Google Meet link),
- emails a confirmation to the client (with a cancel link) and a heads-up to Jared.

No third-party service, no subscription. This folder is listed in
`.assetsignore` so it is never deployed; only `/book/*` ships with the site.

## One-time setup (Jared, about 20 minutes)

1. Go to <https://script.google.com>, signed in as `fries.jared@gmail.com` (the
   account that owns the calendar). New project. Name it `jaredbfries.com booking`.
2. Delete the default code, paste `Code.gs`, save.
3. Project Settings (gear) > tick **Show "appsscript.json" manifest file in editor**.
   Back in the editor, open `appsscript.json` and replace its contents with the
   `appsscript.json` in this folder. This sets the script's time zone, the
   Calendar advanced service (for Meet links), and the OAuth scopes.
4. Sanity check: in the editor pick the `testSlots` function and Run. Authorize
   with the Gmail account, accept the "unverified app" warning. The log shows
   how many open slots exist in the next week and lists the first few.
5. Deploy > New deployment > type **Web app**. Description `booking v1`.
   Execute as **Me**. Who has access **Anyone**. Deploy.
6. Copy the Web app URL (ends in `/exec`) and paste it into the `data-api`
   attribute in `book/index.html`, replacing the `APPS_SCRIPT_DEPLOYMENT_ID`
   placeholder URL. This URL is safe in public HTML.

Every later edit to the script needs Deploy > Manage deployments > edit >
**New version**, or the live URL keeps serving the old code.

## Tuning

Everything lives in the config block at the top of `Code.gs`:

| Setting                | Default              | Notes                                                    |
| ---------------------- | -------------------- | -------------------------------------------------------- |
| `TZ`                   | `America/Los_Angeles`| business hours are in this zone                          |
| `HOURS`                | Mon–Fri 09:00–17:00  | one entry per weekday; a day can have several windows (e.g. `[['09:00','12:00'],['13:00','17:00']]` for a lunch break) |
| `MEETING_TYPES`        | intro 30, working 60 | id, name, length, blurb shown on the card                |
| `SLOT_STEP_MINUTES`    | 30                   | slot start times                                         |
| `BUFFER_MINUTES`       | 15                   | padding around existing events                           |
| `MIN_NOTICE_HOURS`     | 4                    | earliest bookable slot                                   |
| `MAX_DAYS_AHEAD`       | 60                   | how far out the calendar opens                           |
| `BUSY_CALENDAR_IDS`    | `['primary']`        | add other calendar IDs to read busy time from them too   |
| `ALL_DAY_EVENTS_BLOCK` | true                 | vacation and holidays block the whole day                |
| `ADD_MEET_LINK`        | true                 | needs the Calendar advanced service from step 3          |
| `BOOKINGS_SHEET_ID`    | blank                | set a Sheet ID to log every booking as a row             |

Declined invitations do not count as busy. The page links to a meeting type
directly with `/book?type=intro` or `/book?type=working`.

## What happens on a booking

1. The page POSTs the slot, name, email, organization, notes, and the
   client's time zone. The script re-checks the slot under a lock, so two
   people cannot take the same time.
2. `CalendarApp.createEvent` with the client as guest and `sendInvites: true`.
   Google emails the invite; the client's calendar shows it as tentative until
   they accept. A Google Meet room is attached via the Calendar advanced service.
3. `MailApp` sends the client a confirmation (plain text and HTML) in their
   time zone, with Jared's time shown too when it differs, plus a signed
   cancel link. Jared gets a notification with reply-to set to the client.
4. Cancel link → the event is deleted, guests get Google's cancellation, Jared
   gets an email, and the page offers a link back to `/book`.

Reschedule is cancel + rebook. Email quota on a free Gmail account is 100
recipients/day through `MailApp`; each booking uses two.

## Checks before cutover

1. `curl "<exec URL>?action=config"` returns `{"ok":true,"config":{...}}` with both meeting types.
2. `curl "<exec URL>?action=slots&from=2026-10-05&to=2026-10-09&type=intro"`
   returns ISO timestamps only on weekdays, 9:00–4:30 PT starts, none
   overlapping existing events (check against the calendar).
3. Put a test event on the calendar; re-run 2 and confirm the slot and its
   15-minute buffer disappear.
4. Live-site test on desktop and phone with a non-Gmail address if possible:
   the event appears on Jared's calendar with the guest, the invite and the
   confirmation arrive within a minute, the Meet link works, Jared's
   notification arrives with reply-to set to the tester.
5. Change the time zone dropdown to `America/New_York`: slots shift three
   hours later and the confirmation email shows both zones.
6. Click the cancel link in the confirmation: event gone, cancellation email
   arrives, page shows the "cancelled" message; click it again and it says
   "already cancelled".
7. Book the same slot from two tabs: the second one is bounced back to the
   calendar with "That time was just taken".
8. Console clean, no CORS errors.

If bots become a problem later, the next step is Cloudflare Turnstile verified
inside `doPost`, same as the contact form note.
