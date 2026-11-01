/* Fleet Control Room - desktop page for monitoring driver loads and photos.
 * Reads the same Google Sheet and Drive folder as the driver app, through the same Apps Script server.
 * Plain JavaScript, no libraries.
 */
(function () {
  'use strict';

  var CFG = window.CONTROL_CONFIG;
  var DEMO = !CFG.apiUrl;
  var SKEY = 'fleet-control-session';

  var KIND_LABELS = {
    pod_page: 'POD page', loading_slip: 'Loading slip', opening_odometer: 'Opening odometer',
    completed_pod: 'Completed POD', offloading_slip: 'Offloading slip', closing_odometer: 'Closing odometer'
  };
  var KIND_ORDER = ['pod_page', 'loading_slip', 'opening_odometer', 'completed_pod', 'offloading_slip', 'closing_odometer'];
  var STATUS = {
    complete: { label: 'Complete', cls: 'ok' },
    road: { label: 'On the road', cls: 'info' },
    overdue: { label: 'Overdue offloading', cls: 'warn' },
    noload: { label: 'No loading captured', cls: 'grey' }
  };
  var REVIEW = {
    ok: { label: 'Checked OK', cls: 'ok' },
    problem: { label: 'Problem', cls: 'bad' },
    todo: { label: 'Not checked', cls: 'grey' }
  };

  var session = null;
  var data = null;        // last reply from the server
  var pods = [];          // loads grouped by POD number, for the chosen period
  var range = null;
  var sort = { key: 'last', asc: false };
  var openPod = null;
  var refreshTimer = null;
  var photoCache = {};

  /* ---------------- Helpers ---------------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ms(v) { if (v == null || v === '') return null; var t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  function pad(n) { return ('0' + n).slice(-2); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmt(t) {
    if (!t) return '–';
    var d = new Date(t);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDay(t) { var d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function dur(m) {
    if (m == null) return '–';
    var min = Math.round(m / 60000);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60);
    if (h < 48) return h + ' h ' + (min % 60 ? (min % 60) + ' min' : '');
    return Math.round(h / 24) + ' days';
  }
  function ago(t) { return t ? dur(Date.now() - t) + ' ago' : 'never'; }
  function chip(text, cls) { return el('span', 'chip ' + cls, text); }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function show(view) {
    $('view-login').hidden = view !== 'login';
    $('view-main').hidden = view !== 'main';
  }
  function saveSession(s) { try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) {} }
  function loadSession() { try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { return null; } }

  /* ---------------- Server ---------------- */

  function api(action, payload) {
    if (DEMO) return Demo.api(action, payload || {});
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    // Plain text body: avoids a CORS pre-check, which Apps Script does not answer.
    return fetch(CFG.apiUrl, { method: 'POST', body: body, redirect: 'follow' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var j;
        try { j = JSON.parse(text); } catch (e) { throw new Error('The server reply was not understood. Check the apiUrl in config.js.'); }
        if (!j.ok) { var err = new Error(j.error || 'Server error'); err.code = j.code; throw err; }
        return j;
      });
  }

  function authed(action, payload) {
    return api(action, Object.assign({ token: session.token }, payload || {})).catch(function (e) {
      if (e.code === 'AUTH') { signOut(); toast('Please sign in again.'); }
      throw e;
    });
  }

  /* ---------------- Sign in ---------------- */

  function initLogin() {
    $('demo-note').hidden = !DEMO;
    $('login-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = $('login-error');
      err.hidden = true;
      var user = $('login-user').value.trim().toLowerCase();
      var pin = $('login-pin').value.trim();
      if (!user || !pin) { err.textContent = 'Type your username and PIN.'; err.hidden = false; return; }
      $('login-btn').disabled = true;
      api('ctlLogin', { username: user, pin: pin }).then(function (r) {
        session = { token: r.token, username: r.username, name: r.name, expires: r.expires };
        saveSession(session);
        $('login-pin').value = '';
        startMain();
      }).catch(function (e) {
        err.textContent = e.message || 'Could not sign in.';
        err.hidden = false;
      }).then(function () { $('login-btn').disabled = false; });
    });
  }

  function signOut() {
    session = null;
    saveSession(null);
    clearInterval(refreshTimer);
    closeDrawer();
    show('login');
  }

  /* ---------------- Period ---------------- */

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function loadPeriod(offset) {
    var now = new Date(), sd = CFG.periodStartDay || 1;
    var y = now.getFullYear(), m = now.getMonth() - (now.getDate() >= sd ? 0 : 1) + offset;
    var from = new Date(y, m, sd).getTime();
    var to = new Date(y, m + 1, sd).getTime() - 1;
    return { from: from, to: to };
  }
  function computeRange() {
    var v = $('period').value, now = new Date(), today = dayStart(now);
    $('custom-dates').hidden = v !== 'custom';
    if (v === 'today') return { from: today, to: today + 864e5 - 1 };
    if (v === 'yesterday') return { from: today - 864e5, to: today - 1 };
    if (v === '7d') return { from: today - 6 * 864e5, to: today + 864e5 - 1 };
    if (v === 'loadperiod') return loadPeriod(0);
    if (v === 'lastloadperiod') return loadPeriod(-1);
    var f = $('date-from').value, t = $('date-to').value;
    if (!f || !t) return { from: today - 6 * 864e5, to: today + 864e5 - 1 };
    var fp = f.split('-'), tp = t.split('-');
    return { from: new Date(+fp[0], fp[1] - 1, +fp[2]).getTime(), to: new Date(+tp[0], tp[1] - 1, +tp[2]).getTime() + 864e5 - 1 };
  }

  /* ---------------- Main ---------------- */

  function startMain() {
    show('main');
    $('who').textContent = session.name || session.username;
    $('demo-badge').hidden = !DEMO;
    refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!document.hidden && session) refresh(true); }, (CFG.refreshSeconds || 60) * 1000);
  }

  function refresh(quiet) {
    range = computeRange();
    $('period-label').textContent = fmtDay(range.from) + ' – ' + fmtDay(range.to);
    if (!quiet) $('updated').textContent = 'Loading…';
    return authed('ctlData', { from: range.from, to: Math.min(range.to, Date.now() + 60000) }).then(function (r) {
      data = r;
      $('load-error').hidden = true;
      build();
      renderAll();
      $('updated').textContent = 'Updated ' + pad(new Date().getHours()) + ':' + pad(new Date().getMinutes());
    }).catch(function (e) {
      if (e.code === 'AUTH') return;
      $('load-error').textContent = 'Could not load the data: ' + (e.message || e) + ' The page will try again.';
      $('load-error').hidden = false;
      $('updated').textContent = '';
    });
  }

  /* Groups the loads by POD number and works out the status of each POD. */
  function build() {
    var byPod = {};
    data.submissions.forEach(function (s) {
      s.received = ms(s.receivedAt);
      s.captured = ms(s.capturedAt) || s.received;
      s.uploads = [];
      var p = byPod[s.podNo] || (byPod[s.podNo] = { podNo: s.podNo, subs: [], uploads: [] });
      p.subs.push(s);
    });
    var subById = {};
    data.submissions.forEach(function (s) { subById[s.id] = s; });
    data.uploads.forEach(function (u) {
      u.received = ms(u.receivedAt);
      var s = subById[u.submissionId];
      if (s) s.uploads.push(u);
      if (byPod[u.podNo]) byPod[u.podNo].uploads.push(u);
    });

    var now = Date.now();
    pods = Object.keys(byPod).map(function (k) {
      var p = byPod[k];
      p.subs.sort(function (a, b) { return a.captured - b.captured; });
      p.inRange = p.subs.some(function (s) { return s.received >= range.from && s.received <= range.to; });
      p.loading = last(p.subs, 'loading');
      p.offloading = last(p.subs, 'offloading');
      var latest = p.subs[p.subs.length - 1];
      p.fleetNo = latest.fleetNo;
      p.driver = latest.driverName || latest.username;
      p.username = latest.username;
      p.loadedAt = p.loading ? p.loading.captured : null;
      p.offloadedAt = p.offloading ? p.offloading.captured : null;
      p.last = latest.received;
      p.km = (p.loading && p.offloading && p.loading.odometer != null && p.offloading.odometer != null)
        ? p.offloading.odometer - p.loading.odometer : null;
      p.expected = p.subs.reduce(function (n, s) { return n + (s.photos || 0); }, 0);
      p.photos = p.subs.reduce(function (n, s) { return n + uniq(s.uploads).length; }, 0);
      p.flagged = p.uploads.filter(function (u) { return u.flagged; }).length;
      p.low = p.uploads.filter(function (u) { return !u.flagged && u.sharpness != null && u.sharpness < CFG.lowSharpness; }).length;
      if (p.loading && p.offloading) p.status = 'complete';
      else if (p.loading) p.status = (now - p.loading.captured > CFG.overdueHours * 3600000) ? 'overdue' : 'road';
      else p.status = 'noload';
      if (p.subs.some(function (s) { return s.review === 'Problem'; })) p.review = 'problem';
      else if (p.subs.every(function (s) { return s.review === 'OK'; })) p.review = 'ok';
      else p.review = 'todo';
      p.odoIssue = p.km != null && (p.km < 0 || p.km > 2000);
      return p;
    }).filter(function (p) { return p.inRange; });
  }
  function last(subs, stage) {
    var f = subs.filter(function (s) { return s.stage === stage; });
    return f.length ? f[f.length - 1] : null;
  }
  function uniq(list) {
    var seen = {};
    return list.filter(function (u) { var k = u.kind; if (seen[k]) return false; seen[k] = 1; return true; });
  }

  function renderAll() {
    renderTiles();
    renderDriverFilter();
    renderLoads();
    renderAttention();
    renderDrivers();
  }

  /* ---------------- Tiles ---------------- */

  function renderTiles() {
    var subs = data.submissions.filter(function (s) { return s.received >= range.from && s.received <= range.to; });
    var ups = data.uploads.filter(function (u) { return u.received >= range.from && u.received <= range.to; });
    var cnt = function (k) { return pods.filter(function (p) { return p.status === k; }).length; };
    var flagged = ups.filter(function (u) { return u.flagged; }).length;
    var todo = pods.filter(function (p) { return p.review === 'todo'; }).length;
    var problems = pods.filter(function (p) { return p.review === 'problem'; }).length;
    var delays = subs.map(function (s) { return s.received - s.captured; }).filter(function (d) { return d >= 0; }).sort(function (a, b) { return a - b; });
    var median = delays.length ? delays[Math.floor(delays.length / 2)] : null;
    var drivers = {};
    subs.forEach(function (s) { drivers[s.username] = 1; });
    var activeDrivers = data.drivers.filter(function (d) { return d.active; }).length;

    var tiles = [
      { v: subs.length, l: 'Loads captured', s: subs.filter(function (s) { return s.stage === 'loading'; }).length + ' loading · ' +
          subs.filter(function (s) { return s.stage === 'offloading'; }).length + ' offloading', c: 't-info' },
      { v: cnt('complete') + ' / ' + pods.length, l: 'PODs complete', s: 'loading and offloading in', c: 't-ok', go: { status: 'complete' } },
      { v: cnt('road'), l: 'On the road', s: 'loaded, offloading not yet in', c: 't-info', go: { status: 'road' } },
      { v: cnt('overdue'), l: 'Overdue offloading', s: 'no offloading after ' + CFG.overdueHours + ' h', c: cnt('overdue') ? 't-bad' : 't-ok', go: { status: 'overdue' } },
      { v: flagged, l: 'Photos flagged', s: 'of ' + ups.length + ' photos (' + (ups.length ? Math.round(100 * flagged / ups.length) : 0) + '%)', c: flagged ? 't-bad' : 't-ok', go: { tab: 'attention' } },
      { v: todo, l: 'Not checked yet', s: problems + ' marked as problem', c: todo ? 't-warn' : 't-ok', go: { review: 'todo' } },
      { v: median == null ? '–' : dur(median), l: 'Typical send time', s: 'photo taken to control room', c: 't-info' },
      { v: Object.keys(drivers).length + ' / ' + activeDrivers, l: 'Drivers using the app', s: 'active accounts', c: 't-info', go: { tab: 'drivers' } }
    ];
    var wrap = $('tiles');
    wrap.textContent = '';
    tiles.forEach(function (t) {
      var d = el('div', 'tile ' + t.c + (t.go ? ' click' : ''));
      d.appendChild(el('div', 'v', String(t.v)));
      d.appendChild(el('div', 'l', t.l));
      d.appendChild(el('div', 's', t.s));
      if (t.go) d.addEventListener('click', function () { applyGo(t.go); });
      wrap.appendChild(d);
    });
  }

  function applyGo(go) {
    if (go.tab) return switchTab(go.tab);
    $('f-status').value = go.status || '';
    $('f-review').value = go.review || '';
    $('search').value = '';
    $('f-driver').value = '';
    switchTab('loads');
    renderLoads();
  }

  /* ---------------- Loads table ---------------- */

  function renderDriverFilter() {
    var sel = $('f-driver'), cur = sel.value;
    var names = {};
    pods.forEach(function (p) { names[p.username] = p.driver; });
    sel.textContent = '';
    sel.appendChild(el('option', null, 'All drivers')).value = '';
    Object.keys(names).sort(function (a, b) { return names[a].localeCompare(names[b]); }).forEach(function (u) {
      var o = el('option', null, names[u]);
      o.value = u;
      sel.appendChild(o);
    });
    sel.value = names[cur] ? cur : '';
  }

  function filtered() {
    var q = $('search').value.trim().toUpperCase();
    var st = $('f-status').value, rv = $('f-review').value, dr = $('f-driver').value;
    return pods.filter(function (p) {
      if (st && p.status !== st) return false;
      if (rv && p.review !== rv) return false;
      if (dr && p.username !== dr) return false;
      if (q && (p.podNo + ' ' + p.fleetNo + ' ' + p.driver).toUpperCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      var x = a[sort.key], y = b[sort.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      var r = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.asc ? r : -r;
    });
  }

  function renderLoads() {
    var list = filtered();
    var tb = $('loads-table').querySelector('tbody');
    tb.textContent = '';
    list.forEach(function (p) {
      var tr = el('tr');
      if (openPod === p.podNo) tr.className = 'sel';
      tr.appendChild(el('td', 'pod', p.podNo));
      tr.appendChild(el('td', null, p.fleetNo));
      tr.appendChild(el('td', null, p.driver));
      tr.appendChild(el('td', null, fmt(p.loadedAt)));
      tr.appendChild(el('td', null, fmt(p.offloadedAt)));
      var km = el('td', 'num', p.km == null ? '–' : String(p.km));
      if (p.odoIssue) km.className += ' flagnum';
      tr.appendChild(km);
      var ph = el('td', 'num', p.photos + ' / ' + p.expected);
      if (p.photos < p.expected) ph.className += ' flagnum';
      tr.appendChild(ph);
      tr.appendChild(el('td', 'num' + (p.flagged ? ' flagnum' : ''), p.flagged ? String(p.flagged) : '–'));
      var s = el('td'); s.appendChild(chip(STATUS[p.status].label, STATUS[p.status].cls)); tr.appendChild(s);
      var r = el('td'); r.appendChild(chip(REVIEW[p.review].label, REVIEW[p.review].cls)); tr.appendChild(r);
      tr.addEventListener('click', function () { openDrawer(p.podNo); });
      tb.appendChild(tr);
    });
    $('loads-empty').hidden = list.length > 0;
    $('count-loads').textContent = pods.length || '';
    var ths = $('loads-table').querySelectorAll('th[data-sort]');
    for (var i = 0; i < ths.length; i++) {
      var k = ths[i].getAttribute('data-sort');
      ths[i].className = (k === sort.key || (k === 'driver' && sort.key === 'driver')) ? ('sorted' + (sort.asc ? ' asc' : '')) : '';
      if (ths[i].classList.contains('num') || k === 'km' || k === 'photos' || k === 'flagged') ths[i].classList.add('num');
    }
  }

  function exportCsv() {
    var rows = [['POD', 'Truck', 'Driver', 'Loaded', 'Offloaded', 'Km', 'Photos received', 'Photos expected', 'Flagged photos', 'Status', 'Checked', 'Notes']];
    filtered().forEach(function (p) {
      rows.push([p.podNo, p.fleetNo, p.driver, fmt(p.loadedAt), fmt(p.offloadedAt), p.km == null ? '' : p.km, p.photos, p.expected,
                 p.flagged, STATUS[p.status].label, REVIEW[p.review].label,
                 p.subs.map(function (s) { return s.reviewNote; }).filter(Boolean).join(' | ')]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'fleet-loads-' + new Date(range.from).toISOString().slice(0, 10) + '-to-' + new Date(range.to).toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------------- Needs attention ---------------- */

  function attentionItems() {
    var items = [];
    pods.forEach(function (p) {
      if (p.review === 'problem') items.push({ sev: 0, pod: p, what: 'Marked as a problem', why: p.subs.map(function (s) { return s.reviewNote; }).filter(Boolean).join(' · '), t: p.last, cls: 'bad' });
      if (p.photos < p.expected) items.push({ sev: 0, pod: p, what: (p.expected - p.photos) + ' photo(s) missing', why: 'The phone reported more photos than arrived.', t: p.last, cls: 'bad' });
      p.uploads.filter(function (u) { return u.flagged; }).forEach(function (u) {
        items.push({ sev: 1, pod: p, what: KIND_LABELS[u.kind] + ' sent after failing the photo check', why: 'Sharpness ' + (u.sharpness == null ? '?' : u.sharpness) + '. Check the numbers can be read.', t: u.received, cls: 'bad' });
      });
      if (p.low) items.push({ sev: 2, pod: p, what: p.low + ' photo(s) with low sharpness', why: 'Below ' + CFG.lowSharpness + '.', t: p.last, cls: 'warn' });
      if (p.status === 'overdue') items.push({ sev: 1, pod: p, what: 'No offloading after ' + dur(Date.now() - p.loadedAt), why: 'Loaded ' + fmt(p.loadedAt) + '.', t: p.loadedAt, cls: 'warn' });
      if (p.odoIssue) items.push({ sev: 1, pod: p, what: p.km < 0 ? 'Closing odometer is lower than opening' : 'Very long distance: ' + p.km + ' km', why: 'Opening ' + p.loading.odometer + ' · closing ' + p.offloading.odometer + '.', t: p.last, cls: 'warn' });
      if (p.status === 'noload') items.push({ sev: 3, pod: p, what: 'Offloading without loading documents', why: 'Loading may have been before the period, or not captured.', t: p.last, cls: 'grey' });
    });
    if (CFG.dataAllowanceMb) {
      driverRows().forEach(function (d) {
        if (d.dataMb != null && d.dataMb > CFG.dataAllowanceMb) items.push({ sev: 2, driver: d, what: d.name + ' is over the work-data allowance', why: d.dataMb + ' MB of ' + CFG.dataAllowanceMb + ' MB this month.', t: d.lastUpload, cls: 'warn' });
      });
    }
    return items.sort(function (a, b) { return a.sev - b.sev || (b.t || 0) - (a.t || 0); });
  }

  function renderAttention() {
    var items = attentionItems();
    var ul = $('attention');
    ul.textContent = '';
    items.forEach(function (it) {
      var li = el('li');
      li.appendChild(chip(it.pod ? it.pod.podNo : 'Driver', it.cls));
      var txt = el('div');
      txt.appendChild(el('div', 'what', it.what));
      txt.appendChild(el('div', 'muted', (it.pod ? it.pod.fleetNo + ' · ' + it.pod.driver + '. ' : '') + (it.why || '')));
      li.appendChild(txt);
      li.appendChild(el('span', 'when', fmt(it.t)));
      li.addEventListener('click', function () { if (it.pod) openDrawer(it.pod.podNo); else switchTab('drivers'); });
      ul.appendChild(li);
    });
    $('attention-empty').hidden = items.length > 0;
    $('count-attention').textContent = items.length || '';
  }

  /* ---------------- Drivers ---------------- */

  function driverRows() {
    var map = {};
    data.drivers.forEach(function (d) {
      map[d.username] = { username: d.username, name: d.name || d.username, fleetNo: d.fleetNo, active: d.active, lastLogin: ms(d.lastLogin),
                          lastUpload: null, loads: 0, flagged: 0, sharp: [], dataMb: null, dataAt: 0 };
    });
    var monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    data.submissions.forEach(function (s) {
      var d = map[s.username] || (map[s.username] = { username: s.username, name: s.driverName || s.username, fleetNo: s.fleetNo, active: null,
                                                       lastLogin: null, lastUpload: null, loads: 0, flagged: 0, sharp: [], dataMb: null, dataAt: 0 });
      if (s.received >= range.from && s.received <= range.to) d.loads++;
      if (!d.lastUpload || s.received > d.lastUpload) { d.lastUpload = s.received; d.lastFleet = s.fleetNo; }
      if (s.workDataMb != null && s.captured >= monthStart && s.captured >= d.dataAt) { d.dataMb = s.workDataMb; d.dataAt = s.captured; }
    });
    data.uploads.forEach(function (u) {
      var d = map[u.username];
      if (!d || u.received < range.from || u.received > range.to) return;
      if (u.flagged) d.flagged++;
      if (u.sharpness != null) d.sharp.push(u.sharpness);
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (b.lastUpload || 0) - (a.lastUpload || 0) || a.name.localeCompare(b.name); });
  }

  function renderDrivers() {
    var rows = driverRows();
    var tb = $('drivers-table').querySelector('tbody');
    tb.textContent = '';
    rows.forEach(function (d) {
      var tr = el('tr');
      var n = el('td');
      n.appendChild(el('strong', null, d.name));
      n.appendChild(el('span', 'muted', ' ' + d.username));
      tr.appendChild(n);
      tr.appendChild(el('td', null, d.lastFleet || d.fleetNo || '–'));
      var a = el('td');
      a.appendChild(d.active === false ? chip('Blocked', 'bad') : d.active ? chip('Active', 'ok') : chip('Not in Drivers tab', 'grey'));
      tr.appendChild(a);
      tr.appendChild(el('td', null, d.lastLogin ? fmt(d.lastLogin) : '–'));
      var lu = el('td', null, d.lastUpload ? ago(d.lastUpload) + ' ' : 'none ');
      if (d.active && d.lastUpload && Date.now() - d.lastUpload > CFG.quietHours * 3600000) lu.appendChild(chip('Quiet', 'warn'));
      tr.appendChild(lu);
      tr.appendChild(el('td', 'num', String(d.loads)));
      tr.appendChild(el('td', 'num' + (d.flagged ? ' flagnum' : ''), String(d.flagged)));
      tr.appendChild(el('td', 'num', d.sharp.length ? String(Math.round(d.sharp.reduce(function (x, y) { return x + y; }, 0) / d.sharp.length)) : '–'));
      var dm = el('td', 'num', d.dataMb == null ? '–' : d.dataMb + ' MB');
      if (CFG.dataAllowanceMb && d.dataMb > CFG.dataAllowanceMb) dm.className += ' flagnum';
      tr.appendChild(dm);
      tb.appendChild(tr);
    });
    $('count-drivers').textContent = rows.length || '';
  }

  /* ---------------- Tabs ---------------- */

  function switchTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    ['loads', 'attention', 'drivers'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
  }

  /* ---------------- Load detail ---------------- */

  function openDrawer(podNo) {
    var p = pods.filter(function (x) { return x.podNo === podNo; })[0];
    if (!p) return;
    openPod = podNo;
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    renderDrawer(p);
    renderLoads();
  }

  function closeDrawer() {
    openPod = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    if (data) renderLoads();
  }

  function renderDrawer(p) {
    $('d-title').textContent = p.podNo;
    var sub = $('d-sub');
    sub.textContent = '';
    sub.appendChild(chip(STATUS[p.status].label, STATUS[p.status].cls));
    sub.appendChild(document.createTextNode(' '));
    sub.appendChild(chip(REVIEW[p.review].label, REVIEW[p.review].cls));
    sub.appendChild(document.createTextNode('  ' + p.fleetNo + ' · ' + p.driver));

    var body = $('d-body');
    body.textContent = '';

    var sum = el('div', 'card');
    sum.appendChild(el('h3', null, 'Summary'));
    var dl = el('dl', 'facts');
    fact(dl, 'Loaded', fmt(p.loadedAt));
    fact(dl, 'Offloaded', fmt(p.offloadedAt));
    if (p.loadedAt && p.offloadedAt) fact(dl, 'Loaded to offloaded', dur(p.offloadedAt - p.loadedAt));
    fact(dl, 'Distance (odometer)', p.km == null ? '–' : p.km + ' km' + (p.odoIssue ? '  ⚠ check the odometer photos' : ''));
    fact(dl, 'Photos', p.photos + ' of ' + p.expected + ' received' + (p.flagged ? ' · ' + p.flagged + ' flagged' : ''));
    var folder = p.subs.map(function (s) { return s.folder; }).filter(Boolean)[0];
    if (folder) {
      var a = el('a', null, 'Open the POD folder in Google Drive');
      a.href = folder; a.target = '_blank'; a.rel = 'noopener';
      fact(dl, 'Drive', a);
    }
    sum.appendChild(dl);
    body.appendChild(sum);

    p.subs.slice().sort(function (a, b) { return a.stage === b.stage ? a.captured - b.captured : (a.stage === 'loading' ? -1 : 1); })
      .forEach(function (s) { body.appendChild(stageCard(p, s)); });
  }

  function fact(dl, k, v) {
    dl.appendChild(el('dt', null, k));
    var dd = el('dd');
    if (typeof v === 'string') dd.textContent = v; else dd.appendChild(v);
    dl.appendChild(dd);
  }

  function stageCard(p, s) {
    var card = el('div', 'card');
    var h = el('h3', null, s.stage === 'loading' ? 'Loading' : 'Offloading');
    if (s.flagged) h.appendChild(chip(s.flagged + ' flagged', 'bad'));
    card.appendChild(h);
    var dl = el('dl', 'facts');
    fact(dl, 'Driver', (s.driverName || s.username) + ' (' + s.username + ')');
    fact(dl, 'Truck', s.fleetNo);
    fact(dl, 'Captured', fmt(s.captured));
    fact(dl, 'Received', fmt(s.received) + (s.received - s.captured > 15 * 60000 ? '  (' + dur(s.received - s.captured) + ' later, no signal?)' : ''));
    fact(dl, 'Odometer', s.odometer == null ? '–' : s.odometer + ' km');
    if (s.lat != null && s.lng != null) {
      var a = el('a', null, s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) + ' on the map');
      a.href = 'https://www.google.com/maps?q=' + s.lat + ',' + s.lng;
      a.target = '_blank'; a.rel = 'noopener';
      var span = el('span');
      span.appendChild(a);
      if (s.accuracy != null) span.appendChild(document.createTextNode(' (within ' + s.accuracy + ' m)'));
      fact(dl, 'Location', span);
    } else fact(dl, 'Location', 'not available');
    card.appendChild(dl);

    var got = s.uploads.slice().sort(function (a, b) { return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind); });
    if (got.length < s.photos) card.appendChild(el('p', 'warnline', (s.photos - got.length) + ' of ' + s.photos + ' photos have not arrived.'));
    var grid = el('div', 'photos');
    got.forEach(function (u) {
      var box = el('div', 'ph');
      var img = el('div', 'img' + (u.flagged ? ' flag' : ''), 'Loading…');
      box.appendChild(img);
      box.appendChild(el('div', 'cap', KIND_LABELS[u.kind] || u.kind));
      var meta = el('div', 'meta', 'Sharpness ' + (u.sharpness == null ? '?' : u.sharpness) + (u.flagged ? ' · sent after failing check' : ''));
      box.appendChild(meta);
      box.addEventListener('click', function () { openPhoto(u, p); });
      grid.appendChild(box);
      loadThumb(u, img);
    });
    card.appendChild(grid);
    card.appendChild(reviewBox(p, s));
    return card;
  }

  function reviewBox(p, s) {
    var wrap = el('div', 'review');
    var state = el('p', 'muted');
    if (s.review) state.textContent = (s.review === 'OK' ? 'Checked OK' : 'Problem') + ' · ' + (s.reviewedBy || '') + ' · ' + fmt(ms(s.reviewedAt));
    else state.textContent = 'Not checked yet.';
    wrap.appendChild(state);
    var note = el('textarea');
    note.placeholder = 'Note (optional), for example: odometer not readable, called driver';
    note.value = s.reviewNote || '';
    wrap.appendChild(note);
    var row = el('div', 'review-row');
    var okBtn = el('button', 'btn ok', 'Looks good');
    var badBtn = el('button', 'btn bad', 'Problem');
    var clrBtn = el('button', 'btn ghost', 'Clear');
    [okBtn, badBtn, clrBtn].forEach(function (b) { b.type = 'button'; row.appendChild(b); });
    if (!s.review) clrBtn.hidden = true;
    wrap.appendChild(row);
    function save(status) {
      if (status === 'Problem' && !note.value.trim()) { note.focus(); toast('Write a short note about the problem.'); return; }
      okBtn.disabled = badBtn.disabled = clrBtn.disabled = true;
      authed('ctlReview', { submissionId: s.id, status: status, note: status ? note.value.trim() : '' }).then(function (r) {
        s.review = status;
        s.reviewNote = status ? note.value.trim() : '';
        s.reviewedBy = r.reviewedBy;
        s.reviewedAt = r.reviewedAt;
        toast(status ? 'Saved.' : 'Cleared.');
        build();
        renderAll();
        var np = pods.filter(function (x) { return x.podNo === p.podNo; })[0];
        if (np) renderDrawer(np);
      }).catch(function (e) {
        toast('Not saved: ' + (e.message || e));
        okBtn.disabled = badBtn.disabled = clrBtn.disabled = false;
      });
    }
    okBtn.addEventListener('click', function () { save('OK'); });
    badBtn.addEventListener('click', function () { save('Problem'); });
    clrBtn.addEventListener('click', function () { save(''); });
    return wrap;
  }

  /* Photos come one at a time from the server (Apps Script handles one request well at a time). */
  var queue = [], busy = false;
  function fetchPhoto(fileId, size) {
    var key = size + ':' + fileId;
    if (photoCache[key]) return Promise.resolve(photoCache[key]);
    return new Promise(function (resolve, reject) {
      queue.push({ key: key, fileId: fileId, size: size, resolve: resolve, reject: reject });
      pump();
    });
  }
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift();
    var done = function () { busy = false; pump(); };
    if (photoCache[job.key]) { job.resolve(photoCache[job.key]); return done(); }
    authed('ctlPhoto', { fileId: job.fileId, size: job.size }).then(function (r) {
      var url = 'data:' + r.mime + ';base64,' + r.data;
      photoCache[job.key] = url;
      job.resolve(url);
    }).catch(job.reject).then(done);
  }

  function loadThumb(u, box) {
    fetchPhoto(u.fileId, 'thumb').then(function (url) {
      box.textContent = '';
      box.style.backgroundImage = 'url("' + url + '")';
    }).catch(function () { box.textContent = 'Could not load'; });
  }

  function openPhoto(u, p) {
    $('lightbox').hidden = false;
    $('lb-img').removeAttribute('src');
    $('lb-cap').textContent = 'Loading the full photo…';
    fetchPhoto(u.fileId, 'full').then(function (url) {
      $('lb-img').src = url;
      $('lb-cap').textContent = p.podNo + ' · ' + (KIND_LABELS[u.kind] || u.kind) + ' · sharpness ' + (u.sharpness == null ? '?' : u.sharpness) +
        (u.flagged ? ' · sent after failing the check' : '');
    }).catch(function (e) { $('lb-cap').textContent = 'Could not load the photo: ' + (e.message || e); });
  }

  /* ---------------- Start ---------------- */

  function init() {
    initLogin();
    $('logout').addEventListener('click', signOut);
    $('refresh').addEventListener('click', function () { refresh(); });
    $('period').addEventListener('change', function () { if ($('period').value !== 'custom') refresh(); else computeRange(); });
    $('date-from').addEventListener('change', function () { if ($('date-from').value && $('date-to').value) refresh(); });
    $('date-to').addEventListener('change', function () { if ($('date-from').value && $('date-to').value) refresh(); });
    ['search', 'f-status', 'f-review', 'f-driver'].forEach(function (id) {
      $(id).addEventListener(id === 'search' ? 'input' : 'change', renderLoads);
    });
    $('export').addEventListener('click', exportCsv);
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', function (ev) { switchTab(ev.currentTarget.getAttribute('data-tab')); });
    var ths = $('loads-table').querySelectorAll('th[data-sort]');
    for (var j = 0; j < ths.length; j++) {
      ths[j].addEventListener('click', function (ev) {
        var k = ev.currentTarget.getAttribute('data-sort');
        if (sort.key === k) sort.asc = !sort.asc; else { sort.key = k; sort.asc = k === 'podNo' || k === 'driver' || k === 'fleetNo'; }
        renderLoads();
      });
    }
    $('d-close').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('lb-close').addEventListener('click', function () { $('lightbox').hidden = true; });
    $('lightbox').addEventListener('click', function (ev) { if (ev.target === $('lightbox')) $('lightbox').hidden = true; });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!$('lightbox').hidden) $('lightbox').hidden = true; else if (!$('drawer').hidden) closeDrawer();
    });

    session = loadSession();
    if (session && session.expires > Date.now()) startMain(); else show('login');
  }

  /* ---------------- Demo data (only when apiUrl is empty) ---------------- */

  var Demo = (function () {
    var seed = 20261031;
    function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    function pick(a) { return a[Math.floor(rnd() * a.length)]; }
    var db = null, odoByFile = {};

    function make() {
      var names = ['Sample Driver A', 'Sample Driver B', 'Sample Driver C', 'Sample Driver D', 'Sample Driver E', 'Sample Driver F', 'Sample Driver G', 'Sample Driver H'];
      var drivers = names.map(function (n, i) {
        return { username: 'driver' + (i + 1), name: n, fleetNo: 'T' + (301 + i * 7), active: i !== 7, lastLogin: new Date(Date.now() - rnd() * 3 * 864e5).toISOString() };
      });
      var subs = [], ups = [], now = Date.now(), pod = 45000;
      var odo = {};
      drivers.forEach(function (d) { odo[d.username] = 200000 + Math.floor(rnd() * 300000); });
      for (var day = 40; day >= 0; day--) {
        drivers.slice(0, 7).forEach(function (d, di) {
          if (rnd() < 0.35) return;
          pod += 1 + Math.floor(rnd() * 3);
          var podNo = 'PLN' + pod;
          var loadT = now - day * 864e5 - (6 + rnd() * 10) * 3600000;
          if (loadT > now - 1800000) return;
          var o1 = odo[d.username] += 20 + Math.floor(rnd() * 80);
          var km = 180 + Math.floor(rnd() * 420);
          var off = loadT + (5 + rnd() * 20) * 3600000;
          var hasOff = off < now - 600000 && !(day <= 3 && di === 2);
          if (day === 1 && di === 4) hasOff = false; // on the road
          addSub(d, podNo, 'loading', loadT, o1, day, di);
          if (hasOff) {
            var o2 = (day === 9 && di === 1) ? o1 - 1200 : o1 + km; // one odometer mistake
            odo[d.username] = Math.max(o1 + km, o2);
            addSub(d, podNo, 'offloading', off, o2, day, di);
          }
        });
      }
      // an offloading whose loading was never captured
      addSub(drivers[5], 'PLN' + (pod + 5), 'offloading', now - 5 * 3600000, odo[drivers[5].username] + 300, 0, 5);

      function addSub(d, podNo, stage, t, odometer, day, di) {
        var id = 'S' + subs.length;
        var delay = rnd() < 0.15 ? (30 + rnd() * 240) * 60000 : (0.5 + rnd() * 3) * 60000;
        var kinds = stage === 'loading' ? ['pod_page', 'loading_slip', 'opening_odometer'] : ['completed_pod', 'offloading_slip', 'closing_odometer'];
        var flagged = 0;
        kinds.forEach(function (k, ki) {
          var f = rnd() < 0.05;
          if (f) flagged++;
          if (day === 6 && di === 3 && ki === 2) return; // one missing photo
          ups.push({ receivedAt: new Date(t + delay - 20000).toISOString(), submissionId: id, username: d.username, podNo: podNo, stage: stage, kind: k,
                     takenAt: new Date(t - (3 - ki) * 60000).toISOString(), sharpness: f ? 40 + Math.floor(rnd() * 70) : 300 + Math.floor(rnd() * 4000),
                     flagged: f, fileId: 'demo-' + podNo + '-' + k + (f ? '-blur' : ''), sizeKb: 300 + Math.floor(rnd() * 400) });
          odoByFile['demo-' + podNo + '-' + k + (f ? '-blur' : '')] = odometer;
        });
        var reviewed = t < now - 2 * 864e5 && rnd() < 0.75;
        var problem = day === 12 && di === 0;
        subs.push({ receivedAt: new Date(t + delay).toISOString(), id: id, username: d.username, driverName: d.name, fleetNo: d.fleetNo, podNo: podNo,
                    stage: stage, odometer: odometer, photos: 3, flagged: flagged,
                    lat: -25.9 + rnd() * 2, lng: 27.2 + rnd() * 2.5, accuracy: 5 + Math.floor(rnd() * 30),
                    capturedAt: new Date(t).toISOString(), workDataMb: +(5 + rnd() * 60).toFixed(1), folder: '',
                    review: problem ? 'Problem' : reviewed ? 'OK' : '', reviewNote: problem ? 'Loading slip weight does not match the weighbridge.' : '',
                    reviewedBy: problem || reviewed ? 'Control room' : '', reviewedAt: problem || reviewed ? new Date(t + 864e5).toISOString() : null });
      }
      return { drivers: drivers, subs: subs, ups: ups };
    }

    function picture(fileId, big) {
      var w = big ? 900 : 240, h = big ? 1200 : 320, s = w / 240;
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var x = c.getContext('2d');
      var parts = fileId.split('-'), pod = parts[1], kind = parts.slice(2).join('_').replace(/_blur$/, '');
      var blur = /-blur$/.test(fileId);
      x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, w, h);
      if (blur) x.filter = 'blur(' + (3 * s) + 'px)';
      if (/odometer/.test(kind)) {
        x.fillStyle = '#111'; x.fillRect(20 * s, 110 * s, 200 * s, 90 * s);
        x.fillStyle = '#9fe3a0'; x.font = 'bold ' + (34 * s) + 'px monospace';
        x.fillText(String(odoByFile[fileId] || ''), 30 * s, 170 * s);
      } else {
        x.fillStyle = '#fbfaf6'; x.fillRect(18 * s, 14 * s, 204 * s, 292 * s);
        x.fillStyle = '#1a1a1a'; x.font = 'bold ' + (15 * s) + 'px Arial';
        x.fillText(KIND_LABELS[kind] ? KIND_LABELS[kind].toUpperCase() : 'DOCUMENT', 30 * s, 42 * s);
        x.font = (12 * s) + 'px Arial';
        x.fillText('No. ' + pod, 30 * s, 64 * s);
        x.fillStyle = '#999';
        for (var i = 0; i < 14; i++) x.fillRect(30 * s, (86 + i * 14) * s, (120 + ((i * 37) % 60)) * s, 3 * s);
        if (/completed/.test(kind)) { x.strokeStyle = '#2353a8'; x.lineWidth = 3 * s; x.beginPath(); x.arc(170 * s, 270 * s, 26 * s, 0, 7); x.stroke(); }
      }
      return c.toDataURL('image/jpeg', 0.8);
    }

    function api(action, p) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (!db) db = make();
          if (action === 'ctlLogin') {
            if (String(p.pin) !== '123456') { var e = new Error('Username or PIN is wrong.'); e.code = 'AUTH_FAILED'; return reject(e); }
            return resolve({ ok: true, token: 'demo', username: p.username, name: p.username, expires: Date.now() + 12 * 3600000 });
          }
          if (action === 'ctlData') {
            var lo = p.from - 14 * 864e5, hi = p.to;
            var inr = function (v) { var t = new Date(v.receivedAt).getTime(); return t >= lo && t <= hi; };
            return resolve({ ok: true, drivers: JSON.parse(JSON.stringify(db.drivers)),
                             submissions: JSON.parse(JSON.stringify(db.subs.filter(inr))), uploads: JSON.parse(JSON.stringify(db.ups.filter(inr))) });
          }
          if (action === 'ctlPhoto') return resolve({ ok: true, mime: 'image/jpeg', data: picture(p.fileId, p.size !== 'thumb').split(',')[1] });
          if (action === 'ctlReview') {
            var s = db.subs.filter(function (x) { return x.id === p.submissionId; })[0];
            if (s) { s.review = p.status; s.reviewNote = p.note; s.reviewedBy = p.status ? 'You (demo)' : ''; s.reviewedAt = p.status ? new Date().toISOString() : null; }
            return resolve({ ok: true, reviewedBy: p.status ? 'You (demo)' : '', reviewedAt: p.status ? new Date().toISOString() : null });
          }
          reject(new Error('Unknown action'));
        }, action === 'ctlPhoto' ? 120 : 300);
      });
    }
    return { api: api };
  })();

  init();
})();
