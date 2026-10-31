/**
 * Fleet Driver App - server (Google Apps Script, bound to the "Fleet App Data" Google Sheet).
 *
 * What it does
 *  - Drivers sign in with a username and 6-digit PIN that the control room sets in the Drivers tab.
 *  - Photos are saved to Google Drive in  "Fleet App Uploads/<POD number>/".
 *  - Every photo is logged in the Uploads tab and every completed load in the Submissions tab.
 *
 * Control room
 *  - Menu "Fleet App > Set up (run once)" creates the tabs, the Drive folder and the secret key.
 *  - Add a driver: fill username, name, fleet_no, new_pin (6 digits), active = TRUE,
 *    then run "Fleet App > Save new PINs". The PIN is stored only as a hash and the plain PIN is cleared.
 *  - Block a driver: set active to FALSE. Their phone is signed out on its next upload.
 */

var TZ = 'Africa/Johannesburg';
var TOKEN_DAYS = 30;
var MAX_FAILS = 5;            // wrong PINs before a 15-minute lockout
var LOCK_SECONDS = 900;

var HEADERS = {
  Drivers: ['username', 'name', 'fleet_no', 'new_pin', 'pin_hash', 'salt', 'active', 'last_login'],
  Uploads: ['received_at', 'photo_id', 'submission_id', 'username', 'fleet_no', 'pod_no', 'stage', 'kind',
            'taken_at', 'sharpness', 'flagged_by_driver', 'file_id', 'file_url', 'size_kb'],
  Submissions: ['received_at', 'submission_id', 'username', 'driver_name', 'fleet_no', 'pod_no', 'stage',
                'odometer_km', 'photos', 'photos_flagged', 'gps_lat', 'gps_lng', 'gps_accuracy_m',
                'captured_at', 'work_data_mb_this_month', 'pod_folder']
};

/* ---------------- Menu and setup ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Fleet App')
    .addItem('Set up (run once)', 'setup')
    .addItem('Save new PINs', 'hashNewPins')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(function (name) { ensureSheet_(ss, name, HEADERS[name]); });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) {
    props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!props.getProperty('ROOT_FOLDER')) {
    var folder = DriveApp.createFolder('Fleet App Uploads');
    props.setProperty('ROOT_FOLDER', folder.getId());
  }
  SpreadsheetApp.getUi().alert(
    'Setup done.\n\nPhotos will be saved in the Drive folder "Fleet App Uploads".\n' +
    'Next: add drivers in the Drivers tab, then run Fleet App > Save new PINs.');
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Hashes every PIN typed in the new_pin column, then clears the plain PIN. */
function hashNewPins() {
  var sh = sheet_('Drivers');
  var data = sh.getDataRange().getValues();
  var h = indexOf_(data[0]);
  var done = 0, bad = [];
  for (var r = 1; r < data.length; r++) {
    var pin = String(data[r][h.new_pin]).trim();
    if (!pin) continue;
    var user = String(data[r][h.username]).trim();
    if (!/^\d{6}$/.test(pin) || !user) { bad.push(r + 1); continue; }
    var salt = Utilities.getUuid();
    sh.getRange(r + 1, h.salt + 1).setValue(salt);
    sh.getRange(r + 1, h.pin_hash + 1).setValue(hash_(salt + pin));
    sh.getRange(r + 1, h.new_pin + 1).setValue('');
    if (data[r][h.active] === '' ) sh.getRange(r + 1, h.active + 1).setValue(true);
    done++;
  }
  SpreadsheetApp.getUi().alert(done + ' PIN(s) saved.' +
    (bad.length ? '\nNot saved (need a username and exactly 6 digits): rows ' + bad.join(', ') : ''));
}

/* ---------------- Web app entry points ---------------- */

function doGet() {
  return out_({ ok: true, app: 'Fleet App server' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out_({ ok: false, error: 'Bad request', code: 'INPUT' }); }
  try {
    switch (req.action) {
      case 'ping':   return out_({ ok: true, time: new Date().toISOString() });
      case 'login':  return out_(login_(req));
      case 'upload': return out_(upload_(req));
      case 'submit': return out_(submit_(req));
      default:       return out_({ ok: false, error: 'Unknown action', code: 'INPUT' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err), code: (err && err.code) || 'SERVER' });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(message, code) {
  var e = new Error(message);
  e.code = code;
  throw e;
}

/* ---------------- Sign in ---------------- */

function login_(req) {
  var user = String(req.username || '').trim().toLowerCase();
  var pin = String(req.pin || '').trim();
  if (!user || !pin) fail_('Type your username and PIN.', 'INPUT');

  var cache = CacheService.getScriptCache();
  var key = 'fails_' + user;
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILS) fail_('Too many wrong PINs. Wait 15 minutes or ask the control room.', 'LOCKED');

  var d = findDriver_(user);
  if (!d || !isActive_(d) || !d.pin_hash || hash_(d.salt + pin) !== d.pin_hash) {
    cache.put(key, String(fails + 1), LOCK_SECONDS);
    fail_('Username or PIN is wrong.', 'AUTH_FAILED');
  }
  cache.remove(key);
  sheet_('Drivers').getRange(d._row, d._h.last_login + 1).setValue(new Date());

  var expires = Date.now() + TOKEN_DAYS * 86400000;
  return { ok: true, token: makeToken_(user, expires), username: user,
           name: String(d.name), fleetNo: String(d.fleet_no).toUpperCase(), expires: expires };
}

function findDriver_(user) {
  var data = sheet_('Drivers').getDataRange().getValues();
  var h = indexOf_(data[0]);
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][h.username]).trim().toLowerCase() === user) {
      var d = { _row: r + 1, _h: h };
      Object.keys(h).forEach(function (k) { d[k] = data[r][h[k]]; });
      return d;
    }
  }
  return null;
}

function isActive_(d) {
  return d.active === true || String(d.active).toUpperCase() === 'TRUE';
}

function makeToken_(user, expires) {
  var payload = user + '|' + expires;
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}

function sign_(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret) fail_('Server not set up yet. Run Fleet App > Set up.', 'SERVER');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret));
}

/** Returns the username for a valid token, or throws AUTH so the phone signs out. */
function verify_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) fail_('Please sign in again.', 'AUTH');
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); }
  catch (err) { fail_('Please sign in again.', 'AUTH'); }
  if (sign_(payload) !== parts[1]) fail_('Please sign in again.', 'AUTH');
  var bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) fail_('Please sign in again.', 'AUTH');
  var d = findDriver_(bits[0]);
  if (!d || !isActive_(d)) fail_('Your account is not active. Contact the control room.', 'AUTH');
  return d;
}

/* ---------------- Photos ---------------- */

function upload_(req) {
  var d = verify_(req.token);
  var pod = clean_(req.podNo), kind = clean_(req.kind), stage = clean_(req.stage);
  var fleet = clean_(req.fleetNo).toUpperCase();
  if (!pod || !kind || !req.photoId || !req.data) fail_('Missing photo details.', 'INPUT');
  if (String(req.data).length > 15000000) fail_('Photo is too large.', 'INPUT');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = findInColumn_('Uploads', 2, req.photoId);
    if (existing) return { ok: true, duplicate: true, fileId: sheet_('Uploads').getRange(existing, 12).getValue() };

    var taken = req.takenAt ? new Date(req.takenAt) : new Date();
    var name = [stage, kind, fleet, Utilities.formatDate(taken, TZ, 'yyyyMMdd-HHmmss')].join('_') + '.jpg';
    var bytes = Utilities.base64Decode(String(req.data));
    var file = podFolder_(pod).createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
    file.setDescription(JSON.stringify({ photoId: req.photoId, submissionId: req.submissionId,
                                         driver: d.username, sharpness: req.sharpness, flagged: !!req.override }));
    sheet_('Uploads').appendRow([new Date(), req.photoId, req.submissionId || '', d.username, fleet, pod, stage, kind,
                                 taken, req.sharpness || '', req.override ? 'YES' : '',
                                 file.getId(), file.getUrl(), Math.round(bytes.length / 1024)]);
    return { ok: true, fileId: file.getId() };
  } finally {
    lock.releaseLock();
  }
}

function podFolder_(pod) {
  var root = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER'));
  var it = root.getFoldersByName(pod);
  return it.hasNext() ? it.next() : root.createFolder(pod);
}

/* ---------------- Completed loads ---------------- */

function submit_(req) {
  var d = verify_(req.token);
  var s = req.submission || {};
  if (!s.id || !s.podNo || !s.stage) fail_('Missing load details.', 'INPUT');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (findInColumn_('Submissions', 2, s.id)) return { ok: true, duplicate: true };
    var pod = clean_(s.podNo);
    sheet_('Submissions').appendRow([
      new Date(), s.id, d.username, String(d.name), clean_(s.fleetNo).toUpperCase(), pod, clean_(s.stage),
      s.odometer || '', s.photoCount || '', s.flagged || 0,
      s.lat || '', s.lng || '', s.accuracy || '',
      s.createdAt ? new Date(s.createdAt) : '', s.workDataMb || '', podFolder_(pod).getUrl()
    ]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Helpers ---------------- */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) fail_('Server not set up yet. Run Fleet App > Set up.', 'SERVER');
  return sh;
}

function indexOf_(headerRow) {
  var h = {};
  headerRow.forEach(function (name, i) { h[String(name).trim()] = i; });
  return h;
}

function findInColumn_(sheetName, col, value) {
  if (!value) return 0;
  var sh = sheet_(sheetName);
  if (sh.getLastRow() < 2) return 0;
  var cell = sh.getRange(2, col, sh.getLastRow() - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Keeps folder and file names safe: letters, numbers, dash and underscore only. */
function clean_(v) {
  return String(v == null ? '' : v).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
