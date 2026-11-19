/**
 * Olive oil preorder backend.
 *
 * Paste this into the Google Sheet via Extensions → Apps Script,
 * then deploy as a Web app (Execute as: Me, Who has access: Anyone).
 *
 * Permissions are set in appsscript.json: this spreadsheet only, outgoing requests
 * (for the captcha check) and sending email (for the confirmation link). Nothing else.
 *
 * How an order flows:
 *   1. The form posts the order. It is checked and stored in the hidden sheet "Onbevestigd".
 *   2. The customer gets an email with a link to the order page (?bevestig=<code>).
 *   3. On that page they click "Bevestigen", which posts the code back here.
 *   4. Only then is the order moved to the "Bestellingen" sheet.
 * This way nobody can place an order in someone else's name.
 *
 * @OnlyCurrentDoc
 */

// ============================================================================
// LINKS — fill these in
// ============================================================================

// Address of the order page. The confirmation link in the email points here.
// To test locally, temporarily use the address from `npx serve .`, e.g. 'http://localhost:3000/'.
// Redeploy the script (Deploy → Manage deployments → New version) after changing it.
const SITE_URL = 'https://lowelman.github.io/Olijfolie/';
//const SITE_URL = 'https://<your-username>.github.io/<repo>/';

// Cloudflare's captcha check. Fixed address, no need to change it.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// The Turnstile secret key is NOT stored here: it goes in Project Settings → Script Properties
// as TURNSTILE_SECRET, so it never ends up on GitHub.

// ============================================================================

const SHEET_NAME = 'Bestellingen';
const HEADERS = ['Tijdstip', 'Naam', 'E-mail', 'Aantal kannen'];
const PENDING_SHEET_NAME = 'Onbevestigd';
const PENDING_HEADERS = ['Controlecode', 'Tijdstip', 'Naam', 'E-mail', 'Aantal kannen'];
const MAX_JUGS = 15;
const CONFIRM_HOURS = 48; // how long the confirmation link stays valid

// Anti-spam limits (the cache keeps counts for at most 6 hours).
const MAX_ORDERS_PER_EMAIL = 3;     // per email address, per 6 hours (also stops mail-bombing someone)
const MAX_ORDERS_PER_HOUR = 100;    // for all visitors together

// Strict email format. Must start with a letter or digit, so it can never start with = + - @
// (which spreadsheet programs like Excel could run as a formula).
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$/;

// Names must start with a letter and may only contain letters (including é, ü, ç, …),
// spaces, hyphens, apostrophes and periods.
const NAME_CHARS_RE = /^\p{L}[\p{L}\p{M}' ’.\-]*$/u;

// Rejected when the WHOLE name is one of these (after removing accents, case and punctuation).
// Kept to "whole name only" so real people named e.g. Jesús García are still allowed.
const BLOCKED_FULL_NAMES = [
  'jezus', 'jesus', 'christus', 'christ', 'jezus christus', 'jesus christus', 'jesus christ', 'jezus christ',
  'god', 'allah', 'boeddha', 'buddha', 'satan', 'duivel', 'lucifer',
  'sinterklaas', 'zwarte piet', 'kerstman', 'santa', 'santa claus',
  'mickey mouse', 'donald duck', 'test', 'testing', 'admin', 'anoniem', 'anonymous',
  'naam', 'name', 'niemand', 'nobody', 'asdf', 'qwerty',
];

// Rejected when these words or phrases appear ANYWHERE in the name.
const BLOCKED_PARTS = [
  'hitler', 'stalin', 'mussolini', 'himmler', 'goebbels', 'pol pot', 'bin laden', 'nazi',
  'satan', 'lucifer', 'van nazareth',
  'kanker', 'klootzak', 'kut', 'lul', 'hoer', 'fuck', 'shit',
];

const GENERIC_ERROR = 'Er ging iets mis. Probeer het opnieuw.';
const INVALID_LINK = 'Deze bevestigingslink is ongeldig of verlopen. Plaats je bestelling opnieuw.';

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'confirm') return json_(confirmOrder_(String(p.code || '')));
  return json_(placeOrder_(p));
}

// Lets you check the deployment by opening the URL in a browser.
function doGet() {
  return json_({ ok: true, status: 'Bestelformulier actief' });
}

// Step 1: check the order, store it as unconfirmed and email the confirmation link.
function placeOrder_(p) {
  // Honeypot: real visitors never fill this hidden field. Pretend success for bots.
  if (p.website) return { ok: true };

  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim().toLowerCase();
  const jugsRaw = String(p.jugs || '').trim();
  const jugs = /^\d{1,2}$/.test(jugsRaw) ? Number(jugsRaw) : NaN; // plain digits only, no "1e1" or "0x5"

  const errors = {};
  const nameError = nameError_(name);
  if (nameError) errors.name = nameError;
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Vul een geldig e-mailadres in.';
  if (!Number.isInteger(jugs) || jugs < 1 || jugs > MAX_JUGS) {
    errors.jugs = 'Kies een aantal tussen 1 en ' + MAX_JUGS + '.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors: errors };

  if (!verifyCaptcha_(String(p.token || ''))) {
    return { ok: false, message: 'De beveiligingscontrole is mislukt. Probeer het opnieuw.' };
  }

  const siteUrl = SITE_URL;
  if (!/^https?:\/\/[^\s"'<>]+$/.test(siteUrl)) {
    console.error('SITE_URL at the top of Code.gs is not filled in or invalid. All orders are refused until it is set.');
    return { ok: false, message: GENERIC_ERROR };
  }

  if (MailApp.getRemainingDailyQuota() < 1) {
    console.error('Daily email quota used up.');
    return { ok: false, message: 'Er kunnen vandaag geen bestellingen meer geplaatst worden. Probeer het morgen opnieuw.' };
  }

  // 32 random hex characters. Only its hash is stored, so people with access to the
  // spreadsheet can't confirm someone else's order.
  const code = Utilities.getUuid().replace(/-/g, '');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const limitError = checkRateLimit_(email);
    if (limitError) return { ok: false, message: limitError };

    getSheet_(); // make sure the visible sheet exists before the hidden one is created
    const pending = getPendingSheet_();
    removeExpired_(pending);
    pending.appendRow([sha256Hex_(code), new Date(), safeCell_(name), safeCell_(email), jugs]);
  } catch (err) {
    console.error(err);
    return { ok: false, message: GENERIC_ERROR };
  } finally {
    lock.releaseLock();
  }

  try {
    sendConfirmationEmail_(email, name, jugs, siteUrl + (siteUrl.indexOf('?') === -1 ? '?' : '&') + 'bevestig=' + code);
  } catch (err) {
    console.error('Sending the confirmation email failed: ' + err);
    return { ok: false, message: 'We konden geen e-mail sturen naar dit adres. Controleer het en probeer het opnieuw.' };
  }

  return { ok: true };
}

// Step 2: the customer clicked "Bevestigen" on the page behind the email link.
function confirmOrder_(code) {
  if (!/^[0-9a-f]{32}$/.test(code)) return { ok: false, message: INVALID_LINK };

  const hash = sha256Hex_(code);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const pending = getPendingSheet_();
    const cell = pending.getRange('A:A').createTextFinder(hash).matchEntireCell(true).findNext();
    if (!cell) {
      // Clicked twice? Then show the same result again instead of an error.
      const done = cache.get('done:' + hash);
      if (done) return Object.assign({ ok: true, already: true }, JSON.parse(done));
      return { ok: false, message: INVALID_LINK };
    }

    const row = cell.getRow();
    const values = pending.getRange(row, 1, 1, PENDING_HEADERS.length).getValues()[0];
    const created = new Date(values[1]).getTime();
    const name = String(values[2]);
    const email = String(values[3]);
    const jugs = Number(values[4]);

    if (!(Date.now() - created < CONFIRM_HOURS * 3600000)) {
      pending.deleteRow(row);
      return { ok: false, message: INVALID_LINK };
    }

    getSheet_().appendRow([new Date(), safeCell_(name), safeCell_(email), jugs]);
    pending.deleteRow(row);

    const result = { name: name, jugs: jugs };
    cache.put('done:' + hash, JSON.stringify(result), 21600); // 6 hours
    return Object.assign({ ok: true }, result);
  } catch (err) {
    console.error(err);
    return { ok: false, message: GENERIC_ERROR };
  } finally {
    lock.releaseLock();
  }
}

function sendConfirmationEmail_(email, name, jugs, link) {
  const amount = jugs + ' ' + (jugs === 1 ? 'kan' : 'kannen');
  const safeName = escapeHtml_(name);
  const safeLink = escapeHtml_(link);

  MailApp.sendEmail({
    to: email,
    name: 'Olijfolie',
    subject: 'Bevestig je bestelling olijfolie',
    body:
      'Hallo ' + name + ',\n\n' +
      'Bedankt voor je bestelling van ' + amount + ' olijfolie.\n' +
      'Open de link hieronder en klik op "Bestelling bevestigen". Pas daarna is je bestelling definitief.\n\n' +
      link + '\n\n' +
      'De link is ' + CONFIRM_HOURS + ' uur geldig.\n' +
      'Heb je niets besteld? Dan mag je deze e-mail negeren. Er wordt dan niets besteld.',
    htmlBody:
      '<p>Hallo ' + safeName + ',</p>' +
      '<p>Bedankt voor je bestelling van <b>' + amount + '</b> olijfolie.<br>' +
      'Klik op de knop hieronder en daarna op <b>Bestelling bevestigen</b>. Pas daarna is je bestelling definitief.</p>' +
      '<p><a href="' + safeLink + '" style="display:inline-block;padding:12px 20px;background:#6c7a2c;color:#ffffff;' +
      'border-radius:8px;text-decoration:none;font-weight:bold">Bestelling bevestigen</a></p>' +
      '<p>Werkt de knop niet? Kopieer dan deze link naar je browser:<br>' + safeLink + '</p>' +
      '<p>De link is ' + CONFIRM_HOURS + ' uur geldig. Heb je niets besteld? Dan mag je deze e-mail negeren. ' +
      'Er wordt dan niets besteld.</p>',
  });
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

// Hidden sheet with orders that are waiting for email confirmation.
function getPendingSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PENDING_SHEET_NAME);
    sheet.appendRow(PENDING_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, PENDING_HEADERS.length).setFontWeight('bold');
    sheet.hideSheet();
  }
  return sheet;
}

// Rows are added in time order, so expired ones are always at the top.
function removeExpired_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const times = sheet.getRange(2, 2, last - 1, 1).getValues();
  const cutoff = Date.now() - CONFIRM_HOURS * 3600000;
  let expired = 0;
  while (expired < times.length && !(new Date(times[expired][0]).getTime() >= cutoff)) expired++;
  if (expired > 0) sheet.deleteRows(2, expired);
}

// Returns a Dutch error message, or null when the name is acceptable.
function nameError_(name) {
  if (name.length < 2 || name.length > 100) return 'Vul je naam in.';
  if (!NAME_CHARS_RE.test(name)) return 'Gebruik alleen letters in je naam (geen cijfers of tekens).';
  if ((name.match(/\p{L}/gu) || []).length < 2) return 'Vul je naam in.';
  if (/(\p{L})\1\1/iu.test(name)) return 'Vul je echte naam in.'; // e.g. "aaaa"

  // "Adolf  HITLER", "Jézus" → "adolf hitler", "jezus"
  const normalized = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  const padded = ' ' + normalized + ' ';

  if (BLOCKED_FULL_NAMES.indexOf(normalized) !== -1) return 'Vul je echte naam in.';
  if (BLOCKED_PARTS.some(function (part) { return padded.indexOf(' ' + part + ' ') !== -1; })) {
    return 'Vul je echte naam in.';
  }
  return null;
}

// Asks Cloudflare whether the Turnstile captcha token is genuine (and unused).
// The secret key is stored in Project Settings → Script Properties as TURNSTILE_SECRET,
// so it never appears in the code or on GitHub.
function verifyCaptcha_(token) {
  if (!token || token.length > 2048) return false;

  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) {
    console.error('Script property TURNSTILE_SECRET is missing. All orders are refused until it is set.');
    return false;
  }

  try {
    const res = UrlFetchApp.fetch(TURNSTILE_VERIFY_URL, {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true,
    });
    const result = JSON.parse(res.getContentText());
    if (result.success !== true) console.warn('Captcha rejected: ' + JSON.stringify(result['error-codes']));
    return result.success === true;
  } catch (err) {
    console.error('Captcha check failed: ' + err);
    return false;
  }
}

// Limits how many orders can come in, so nobody can flood the spreadsheet or someone's inbox.
// Must be called while holding the script lock. Returns an error message, or null and counts the order.
function checkRateLimit_(email) {
  const cache = CacheService.getScriptCache();
  const emailKey = 'email:' + email;
  const hourKey = 'hour:' + Math.floor(Date.now() / 3600000);

  const emailCount = Number(cache.get(emailKey) || 0);
  const hourCount = Number(cache.get(hourKey) || 0);

  if (emailCount >= MAX_ORDERS_PER_EMAIL) {
    return 'Je hebt al meerdere bestellingen geplaatst met dit e-mailadres. Neem contact met ons op als je iets wilt wijzigen.';
  }
  if (hourCount >= MAX_ORDERS_PER_HOUR) {
    return 'Het is momenteel erg druk. Probeer het over een uur opnieuw.';
  }

  cache.put(emailKey, String(emailCount + 1), 21600); // 6 hours
  cache.put(hourKey, String(hourCount + 1), 3600);
  return null;
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

function escapeHtml_(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Extra safety net: stop input like "=HYPERLINK(...)" from being run as a formula in the shared sheet.
function safeCell_(value) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
