# Contact form: Google Apps Script + Google Sheet

The contact form on `/` posts to a Google Apps Script web app that appends a
row to the `Website Leads` Google Sheet and emails Jared. No third-party form
service, no monthly cap that matters. This folder is listed in `.assetsignore`
so it is never deployed.

## One-time setup (Jared, about 15 minutes)

1. Create a Google Sheet named `Website Leads`. Rename the first tab `Leads`.
2. Add a header row in row 1, exactly:
   `Timestamp | Name | Email | Organization | Interest | Message | Source | Page | User Agent`
3. Extensions > Apps Script. Delete the default code, paste `Code.gs`, save.
4. `NOTIFY_EMAIL` must be the Gmail account that owns the Sheet (`fries.jared@gmail.com`), not `jared@jaredbfries.com`. That alias forwards through Cloudflare Email Routing back to the same Gmail, and Gmail drops the forwarded copy as a duplicate of the one in Sent, so the alert never reaches the inbox.
5. Deploy > New deployment > type **Web app**. Description `website form v1`.
   Execute as **Me**. Who has access **Anyone**. Deploy, authorize with the
   Gmail account that owns the Sheet, accept the "unverified app" warning.
6. Copy the Web app URL (ends in `/exec`) and paste it into the form `action`
   in `index.html`, replacing the `APPS_SCRIPT_DEPLOYMENT_ID` placeholder URL.
   This URL is safe in public HTML; it only accepts submissions.

Every later edit to the script needs Deploy > Manage deployments > edit >
**New version**, or the live URL keeps serving the old code.

## What the page sends

| Field          | Source                                                        |
| -------------- | ------------------------------------------------------------- |
| `name`         | text input                                                    |
| `email`        | email input, required                                         |
| `organization` | text input                                                    |
| `interest`     | one value per checked box: `operations`, `compliance`, `playbooks`, `ai-tools`, `edtech-gtm`, `not-sure` |
| `message`      | textarea                                                      |
| `website`      | honeypot, off-screen; any value means spam                    |
| `ts`           | `Date.now()` at page load; under 3 s to submit means spam     |
| `page`         | `location.pathname`                                           |
| `source`       | the `interest=` value from the URL hash, e.g. `runs-without-you` from package CTAs. If it matches a checkbox value the box is pre-checked. |
| `ua`           | `navigator.userAgent`                                         |

The page submits with `fetch` and shows an inline thank-you. With JS off the
form posts natively and lands on a page showing `{"ok":true}`.

## Checks before cutover

1. `curl -X POST -d "name=Test&email=test@example.com&organization=Check&interest=compliance&interest=ai-tools&message=hello&ts=0" <exec URL>`
   returns `{"ok":true}` and a row appears with Interest = `compliance, ai-tools`.
2. Same request with `website=spam` returns `{"ok":true}` and no row is added.
3. Live-site test on desktop and phone: row appears, notification email
   arrives within a minute, Reply on that email goes to the tester's address,
   thank-you state renders in place.
4. Visit `/#contact?interest=runs-without-you`: the row's Source column reads
   `runs-without-you`. Visit `/#contact?interest=compliance`: the Compliance
   box is pre-checked.
5. JS disabled: form still posts natively and lands on `{"ok":true}`.
6. Console clean, no CORS errors.
7. After both PRs are live and one real submission has come through, delete
   the Formspree form (not before).

If spam becomes a problem later, the next step is Cloudflare Turnstile
verified inside `doPost`. Not in scope now.
