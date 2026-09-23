// Contact form backend for jaredbfries.com.
// Lives in the "Website Leads" Google Sheet: Extensions > Apps Script.
// Deployed as a Web app (Execute as: Me, Who has access: Anyone).
// Every edit needs Deploy > Manage deployments > edit > New version,
// or the live /exec URL keeps serving the old code.

const SHEET_NAME = 'Leads';
const NOTIFY_EMAIL = 'fries.jared@gmail.com';  // the Gmail account itself, not the jaredbfries.com alias: that alias forwards back here and Gmail drops the duplicate
const HONEYPOT_FIELD = 'website';   // hidden field; humans leave it blank
const MIN_SECONDS_ON_PAGE = 3;      // bots submit instantly

function doPost(e) {
  try {
    const p = e.parameter || {};
    const multi = e.parameters || {};

    // Spam: honeypot filled, or submitted too fast. Return ok so bots learn nothing.
    if (p[HONEYPOT_FIELD]) return ok();
    const loaded = Number(p.ts || 0);
    if (loaded && (Date.now() - loaded) / 1000 < MIN_SECONDS_ON_PAGE) return ok();

    if (!p.email && !p.message) return fail('empty submission');

    const interests = (multi.interest || []).join(', ');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    sheet.appendRow([
      new Date(),
      p.name || '',
      p.email || '',
      p.organization || '',
      interests,
      p.message || '',
      p.source || '',
      p.page || '',
      p.ua || ''
    ]);

    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      replyTo: p.email || NOTIFY_EMAIL,
      subject: 'New lead: ' + (p.name || 'Unknown') + (p.organization ? ' (' + p.organization + ')' : ''),
      body:
        'Name: ' + (p.name || '') + '\n' +
        'Email: ' + (p.email || '') + '\n' +
        'Organization: ' + (p.organization || '') + '\n' +
        'Interest: ' + interests + '\n' +
        'Source: ' + (p.source || '') + '\n' +
        'Page: ' + (p.page || '') + '\n\n' +
        (p.message || '') + '\n\n' +
        'Sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
    });

    return ok();
  } catch (err) {
    return fail(String(err));
  }
}

function doGet() {
  return ContentService.createTextOutput('ok');
}

function ok() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(msg) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
