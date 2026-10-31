/* Fleet Driver App - proof of concept.
 * Plain JavaScript, no libraries, so it loads fast on low-end phones and works offline.
 */
(function () {
  'use strict';

  var CFG = window.FLEET_CONFIG;
  var DEMO = !CFG.apiUrl;

  var STAGES = {
    loading: {
      title: 'Loading documents',
      photos: [
        { kind: 'pod_page', label: 'POD page', hint: 'The whole page, with the POD number clear.', type: 'doc' },
        { kind: 'loading_slip', label: 'Loading slip / weighbridge ticket', hint: 'The whole slip, with the weight and date clear.', type: 'doc' },
        { kind: 'opening_odometer', label: 'Opening odometer', hint: 'Straight in front, odometer in the middle.', type: 'odo' }
      ]
    },
    offloading: {
      title: 'Offloading documents',
      photos: [
        { kind: 'completed_pod', label: 'Completed POD (signed and stamped)', hint: 'The whole page, with the signature and stamp clear.', type: 'doc' },
        { kind: 'offloading_slip', label: 'Offloading slip / weighbridge ticket', hint: 'The whole slip, with the weight and date clear.', type: 'doc' },
        { kind: 'closing_odometer', label: 'Closing odometer', hint: 'Straight in front, odometer in the middle.', type: 'odo' }
      ]
    }
  };

  var REASONS = {
    blurry: 'The photo is blurry. Hold the phone with both hands and tap the screen on the numbers to focus.',
    dark: 'The photo is too dark. Move to the light or switch on the cab light.',
    glare: 'There is glare or too much light. Tilt the page away from the sun or lamp.'
  };

  /* ---------------- Small helpers ---------------- */

  function $(id) { return document.getElementById(id); }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function monthKey(d) { d = d || new Date(); return 'bytes-' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function fmtMb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) + ' ' +
           d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }
  function cleanPod(v) { return String(v || '').trim().toUpperCase().replace(/\s+/g, ''); }
  function validFleet(v) { return /^[TV][0-9]{2,3}$/.test(v); }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function show(name) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].hidden = screens[i].id !== 'screen-' + name;
    window.scrollTo(0, 0);
  }

  /* ---------------- Storage on the phone (IndexedDB) ---------------- */

  var db;
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('fleet-driver', 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('photos', { keyPath: 'id' });
        d.createObjectStore('loads', { keyPath: 'id' });
        d.createObjectStore('kv');
      };
      req.onsuccess = function () { db = req.result; resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var r = fn(t.objectStore(store));
      var result;
      if (r) r.onsuccess = function () { result = r.result; };
      t.oncomplete = function () { resolve(result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('Phone storage is full')); };
    });
  }
  var store = {
    get: function (s, k) { return tx(s, 'readonly', function (o) { return o.get(k); }); },
    all: function (s) { return tx(s, 'readonly', function (o) { return o.getAll(); }); },
    put: function (s, v, k) { return tx(s, 'readwrite', function (o) { return k === undefined ? o.put(v) : o.put(v, k); }); },
    del: function (s, k) { return tx(s, 'readwrite', function (o) { return o.delete(k); }); }
  };

  function getSession() { return store.get('kv', 'session'); }

  function addBytes(n) {
    var key = monthKey();
    return store.get('kv', key).then(function (v) { return store.put('kv', (v || 0) + n, key); });
  }

  /* ---------------- Server calls ---------------- */

  function api(action, payload) {
    var body = JSON.stringify(Object.assign({ action: action }, payload));
    if (DEMO) return demoApi(action, payload, body);
    // Plain text body: avoids a CORS pre-check, which Apps Script does not answer.
    return fetch(CFG.apiUrl, { method: 'POST', body: body, redirect: 'follow' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        return addBytes(body.length + text.length).then(function () {
          var j;
          try { j = JSON.parse(text); } catch (e) { throw new Error('The server reply was not understood.'); }
          if (!j.ok) { var err = new Error(j.error || 'Server error'); err.code = j.code; throw err; }
          return j;
        });
      });
  }

  function demoApi(action, payload, body) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (action === 'login') {
          if (String(payload.pin) !== '123456') { var e = new Error('Username or PIN is wrong.'); e.code = 'AUTH_FAILED'; return reject(e); }
          return resolve({ ok: true, token: 'demo', username: payload.username, name: payload.username, fleetNo: 'T000', expires: Date.now() + 30 * 864e5 });
        }
        addBytes(body.length).then(function () { resolve({ ok: true, fileId: 'demo' }); });
      }, 400);
    });
  }

  /* ---------------- Sign in ---------------- */

  function initLogin() {
    $('demo-note').hidden = !DEMO;
    $('login-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var user = $('login-user').value.trim().toLowerCase();
      var pin = $('login-pin').value.trim();
      var errEl = $('login-error');
      errEl.hidden = true;
      if (!user || !/^\d{6}$/.test(pin)) {
        errEl.textContent = 'Type your username and your 6-digit PIN.';
        errEl.hidden = false;
        return;
      }
      if (!navigator.onLine && !DEMO) {
        errEl.textContent = 'You need signal to sign in the first time.';
        errEl.hidden = false;
        return;
      }
      $('login-btn').disabled = true;
      api('login', { username: user, pin: pin })
        .then(function (r) {
          return store.put('kv', { token: r.token, username: r.username, name: r.name, fleetNo: r.fleetNo, expires: r.expires }, 'session');
        })
        .then(function () { $('login-pin').value = ''; goHome(); sync(); })
        .catch(function (e) {
          errEl.textContent = e.message || 'Could not sign in. Try again.';
          errEl.hidden = false;
        })
        .then(function () { $('login-btn').disabled = false; });
    });
  }

  function logout() {
    store.del('kv', 'session').then(function () { show('login'); });
  }

  /* ---------------- Home ---------------- */

  function goHome() {
    getSession().then(function (s) {
      if (!s) return show('login');
      $('home-name').textContent = s.name || s.username;
      $('home-fleet').textContent = s.fleetNo || '?';
      show('home');
      renderHome();
    });
  }

  var lastSyncError = '';
  function renderHome() {
    return Promise.all([store.all('loads'), store.all('photos'), store.get('kv', monthKey())]).then(function (res) {
      var loads = res[0].sort(function (a, b) { return b.createdAt - a.createdAt; });
      var waitingPhotos = res[1].filter(function (p) { return p.status !== 'sent'; }).length;
      var waitingLoads = loads.filter(function (l) { return l.status !== 'sent'; }).length;

      if (waitingLoads === 0) {
        $('sync-text').textContent = 'Everything is sent';
        $('sync-sub').textContent = '';
        $('sync-now').hidden = true;
      } else {
        $('sync-text').textContent = waitingPhotos + ' photo' + (waitingPhotos === 1 ? '' : 's') + ' waiting to send';
        $('sync-sub').textContent = !navigator.onLine ? 'No signal. They will send by themselves when you have signal.'
          : (lastSyncError ? 'Last try failed: ' + lastSyncError : 'Sending…');
        $('sync-now').hidden = !navigator.onLine;
      }

      var used = res[2] || 0;
      $('data-used').textContent = fmtMb(used);
      $('data-note').textContent = CFG.dataAllowanceMb
        ? 'Allowance ' + CFG.dataAllowanceMb + ' MB. This counts only what this app uses.'
        : 'This counts only what this app uses.';

      var ul = $('recent');
      ul.textContent = '';
      loads.slice(0, 10).forEach(function (l) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        var left = document.createElement('span');
        left.textContent = (l.stage === 'loading' ? 'Loading' : 'Offloading') + ' · POD ' + l.podNo + ' · ' + fmtDate(l.createdAt);
        var pill = document.createElement('span');
        pill.className = 'pill ' + (l.status === 'sent' ? 'sent' : 'wait');
        pill.textContent = l.status === 'sent' ? 'Sent' : 'Waiting';
        b.appendChild(left);
        b.appendChild(pill);
        b.addEventListener('click', function () { openDetail(l.id); });
        li.appendChild(b);
        ul.appendChild(li);
      });
      $('recent-empty').hidden = loads.length > 0;
    });
  }

  function initHome() {
    var stageBtns = document.querySelectorAll('[data-stage]');
    for (var i = 0; i < stageBtns.length; i++) {
      stageBtns[i].addEventListener('click', function (ev) { startCapture(ev.currentTarget.getAttribute('data-stage')); });
    }
    $('logout').addEventListener('click', function () {
      store.all('loads').then(function (loads) {
        var waiting = loads.some(function (l) { return l.status !== 'sent'; });
        if (waiting) { toast('Some photos are still waiting to send. Sign out after they are sent.'); return; }
        logout();
      });
    });
    $('sync-now').addEventListener('click', function () { sync(); });
    $('change-truck').addEventListener('click', function () {
      getSession().then(function (s) {
        var v = (window.prompt('Which truck are you driving now? (for example T344)', s.fleetNo || '') || '').trim().toUpperCase();
        if (!v) return;
        if (!validFleet(v)) { toast('Type the fleet number like T344.'); return; }
        s.fleetNo = v;
        store.put('kv', s, 'session').then(goHome);
      });
    });
  }

  /* ---------------- Capture checklist ---------------- */

  var draft = null;      // the load being captured
  var activeSlot = null; // photo slot waiting for the camera
  var pending = null;    // photo being checked

  /* The camera is another app. On a small phone Android may close the browser tab while the camera is open,
   * so the load in progress is saved on the phone and restored when the app opens again. */
  function persistDraft() {
    if (!draft || !db) return;
    var d = { id: draft.id, stage: draft.stage, fleetNo: draft.fleetNo, gps: draft.gps, createdAt: draft.createdAt,
              slots: draft.slots, pod: $('pod-no').value, odo: $('odo').value };
    store.put('kv', d, 'draft').catch(function () {});
  }
  function clearDraft() { if (db) store.del('kv', 'draft').catch(function () {}); }

  function restoreDraft(d) {
    draft = { id: d.id, stage: d.stage, fleetNo: d.fleetNo, slots: d.slots, gps: d.gps, createdAt: d.createdAt };
    $('capture-title').textContent = STAGES[d.stage].title;
    $('capture-fleet').textContent = d.fleetNo;
    $('pod-no').value = d.pod || '';
    $('odo').value = d.odo || '';
    $('capture-error').hidden = true;
    renderSlots();
    show('capture');
    toast('Your unfinished load was restored.');
  }

  function startCapture(stage) {
    getSession().then(function (s) {
      draft = { id: uid(), stage: stage, fleetNo: s.fleetNo, slots: {}, gps: null, createdAt: Date.now() };
      STAGES[stage].photos.forEach(function (p) { draft.slots[p.kind] = { photo: null, attempts: 0 }; });
      $('capture-title').textContent = STAGES[stage].title;
      $('capture-fleet').textContent = s.fleetNo;
      $('pod-no').value = '';
      $('odo').value = '';
      $('capture-error').hidden = true;
      clearDraft();
      renderSlots();
      show('capture');
      getGps().then(function (g) { if (draft) draft.gps = g; });
    });
  }

  function getGps() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy) }); },
        function () { resolve(null); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 300000 });
    });
  }

  var thumbUrls = [];
  function renderSlots() {
    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    var wrap = $('slots');
    wrap.textContent = '';
    var defs = STAGES[draft.stage].photos;
    var nextMarked = false;
    defs.forEach(function (def, i) {
      var slot = draft.slots[def.kind];
      var box = document.createElement('div');
      box.className = 'slot';
      if (!slot.photo && !nextMarked) { box.className += ' next'; nextMarked = true; }

      var row = document.createElement('div');
      row.className = 'slot-row';
      var thumb = document.createElement('img');
      thumb.alt = '';
      thumb.className = 'slot-thumb' + (slot.photo ? '' : ' empty');
      if (slot.photo) { var u = URL.createObjectURL(slot.photo.thumb || slot.photo.blob); thumbUrls.push(u); thumb.src = u; }
      var text = document.createElement('div');
      text.className = 'grow';
      var t = document.createElement('p');
      t.className = 'slot-title';
      t.textContent = (i + 1) + '. ' + def.label;
      var st = document.createElement('p');
      if (!slot.photo) { st.className = 'slot-state'; st.textContent = def.hint; }
      else if (slot.photo.flagged) { st.className = 'slot-state flag'; st.textContent = 'Sent for the controller to check'; }
      else { st.className = 'slot-state ok'; st.textContent = 'Clear'; }
      text.appendChild(t);
      text.appendChild(st);
      row.appendChild(thumb);
      row.appendChild(text);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (slot.photo ? 'outline small' : 'primary');
      btn.textContent = slot.photo ? 'Retake' : 'Take photo';
      btn.addEventListener('click', function () { openCamera(def); });

      box.appendChild(row);
      box.appendChild(btn);
      wrap.appendChild(box);
    });
    var hasOdo = defs.some(function (d) { return d.type === 'odo' && draft.slots[d.kind].photo; });
    $('odo-wrap').hidden = !hasOdo;
    updateSend();
  }

  function updateSend() {
    if (!draft) return;
    var allPhotos = STAGES[draft.stage].photos.every(function (d) { return draft.slots[d.kind].photo; });
    var podOk = cleanPod($('pod-no').value).length >= 3;
    var odoOk = Number($('odo').value) > 0;
    var missing = [];
    if (!podOk) missing.push('POD number');
    var left = STAGES[draft.stage].photos.filter(function (d) { return !draft.slots[d.kind].photo; }).length;
    if (left) missing.push(left + ' photo' + (left === 1 ? '' : 's'));
    if (allPhotos && !odoOk) missing.push('odometer reading');
    var btn = $('send-btn');
    btn.disabled = missing.length > 0;
    btn.textContent = missing.length ? 'Send (still needed: ' + missing.join(', ') + ')' : 'Send';
  }

  function openCamera(def) {
    activeSlot = def;
    var input = $('camera-input');
    input.value = '';
    input.click();
  }

  function initCapture() {
    $('pod-no').addEventListener('input', updateSend);
    $('odo').addEventListener('input', updateSend);
    $('capture-back').addEventListener('click', function () {
      var started = draft && Object.keys(draft.slots).some(function (k) { return draft.slots[k].photo; });
      if (started && !window.confirm('Leave without sending? The photos you took will be lost.')) return;
      draft = null;
      clearDraft();
      goHome();
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) persistDraft(); });
    $('pod-no').addEventListener('change', persistDraft);
    $('odo').addEventListener('change', persistDraft);
    $('camera-input').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file || !activeSlot) return;
      toast('Checking the photo…');
      processPhoto(file, activeSlot.type).then(function (p) {
        $('toast').hidden = true;
        draft.slots[activeSlot.kind].attempts += 1;
        pending = p;
        showCheck(p, draft.slots[activeSlot.kind].attempts);
      }).catch(function (e) {
        toast(e.message || 'The photo could not be read. Try again.');
      });
    });
    $('send-btn').addEventListener('click', saveLoad);
  }

  /* ---------------- Photo check ---------------- */

  /* Phone cameras make very large photos (13-50 megapixels). Decoding one in full can use 200 MB of memory and
   * crash the tab on a small phone, so the photo is decoded at the reduced size from the start when the browser allows. */
  function decodeSmall(file) {
    return longSide(file).then(function (long) {
      // A photo that is already small enough is opened as it is (no enlarging).
      if (!window.createImageBitmap || (long && long <= CFG.maxPixels)) return decodeImg(file);
      return createImageBitmap(file, { resizeWidth: CFG.maxPixels, resizeQuality: 'medium' }).then(function (bm) {
        return { src: bm, w: bm.width, h: bm.height, done: function () { if (bm.close) bm.close(); } };
      }).catch(function () { return decodeImg(file); });
    });
  }

  /* Reads the JPEG header only (not the whole photo) to find the longest side in pixels. 0 = unknown. */
  function longSide(file) {
    return new Promise(function (resolve) {
      try {
        var r = new FileReader();
        r.onload = function () {
          var v = new DataView(r.result), i = 2, n = v.byteLength;
          if (n < 4 || v.getUint16(0) !== 0xFFD8) return resolve(0);
          while (i + 9 < n) {
            if (v.getUint8(i) !== 0xFF) { i++; continue; }
            var m = v.getUint8(i + 1);
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
              return resolve(Math.max(v.getUint16(i + 5), v.getUint16(i + 7)));
            }
            i += 2 + v.getUint16(i + 2);
          }
          resolve(0);
        };
        r.onerror = function () { resolve(0); };
        r.readAsArrayBuffer(file.slice(0, 262144));
      } catch (e) { resolve(0); }
    });
  }

  function decodeImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); img.src = ''; } });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('The photo could not be opened. Try again.')); };
      img.src = url;
    });
  }

  function freeCanvas(c) { c.width = 1; c.height = 1; }

  function toBlob(c, quality) {
    return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', quality); });
  }

  function processPhoto(file, type) {
    return decodeSmall(file).then(function (o) {
      var c = document.createElement('canvas');
      var scale = Math.min(1, CFG.maxPixels / Math.max(o.w, o.h));
      c.width = Math.max(1, Math.round(o.w * scale));
      c.height = Math.max(1, Math.round(o.h * scale));
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(o.src, 0, 0, c.width, c.height);
      o.done();
      var m = measure(ctx, c.width, c.height);
      var verdict = judge(m, type);
      var width = c.width, height = c.height;
      // Small copy for the thumbnails, so the full photo is not decoded again just to show a small picture.
      var t = document.createElement('canvas');
      var ts = 240 / Math.max(width, height);
      t.width = Math.max(1, Math.round(width * ts));
      t.height = Math.max(1, Math.round(height * ts));
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
      return toBlob(c, CFG.jpegQuality).then(function (blob) {
        freeCanvas(c);
        return toBlob(t, 0.7).then(function (thumb) {
          freeCanvas(t);
          return { blob: blob, thumb: thumb, width: width, height: height, sharpness: m.sharpness,
                   brightness: m.brightness, glare: m.glare, ok: verdict.ok, reasons: verdict.reasons,
                   takenAt: Date.now() };
        });
      });
    });
  }

  /* Sharpness = variance of the Laplacian (edge strength), measured on 9 tiles across the photo.
   * The 3 sharpest tiles count, so blank parts of a page do not make a sharp photo look blurry. */
  function measure(ctx, w, h) {
    var tile = Math.min(256, Math.floor(w / 3), Math.floor(h / 3));
    var scores = [];
    for (var ty = 0; ty < 3; ty++) {
      for (var tx2 = 0; tx2 < 3; tx2++) {
        var x0 = Math.floor((w / 3) * tx2 + (w / 3 - tile) / 2);
        var y0 = Math.floor((h / 3) * ty + (h / 3 - tile) / 2);
        scores.push(lapVar(ctx.getImageData(x0, y0, tile, tile)));
      }
    }
    scores.sort(function (a, b) { return b - a; });
    var sharpness = Math.round((scores[0] + scores[1] + scores[2]) / 3);

    // Brightness and glare on a small copy of the whole photo.
    var sw = 160, sh = Math.max(1, Math.round(160 * h / w));
    var s = document.createElement('canvas');
    s.width = sw; s.height = sh;
    var sctx = s.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
    var d = sctx.getImageData(0, 0, sw, sh).data;
    freeCanvas(s);
    var sum = 0, hot = 0, n = sw * sh;
    for (var p = 0; p < d.length; p += 4) {
      var v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      sum += v;
      if (v >= 250) hot++;
    }
    return { sharpness: sharpness, brightness: Math.round(sum / n), glare: +(hot / n).toFixed(3) };
  }

  function lapVar(id) {
    var w = id.width, h = id.height, d = id.data;
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    var s = 0, s2 = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var k = y * w + x;
        var l = g[k - w] + g[k + w] + g[k - 1] + g[k + 1] - 4 * g[k];
        s += l; s2 += l * l; n++;
      }
    }
    if (!n) return 0;
    var mean = s / n;
    return s2 / n - mean * mean;
  }

  function judge(m, type) {
    var t = CFG.checks[type];
    var reasons = [];
    if (m.sharpness < t.minSharpness) reasons.push('blurry');
    if (m.brightness < t.minBrightness) reasons.push('dark');
    if (m.brightness > t.maxBrightness || m.glare > t.maxGlare) reasons.push('glare');
    return { ok: reasons.length === 0, reasons: reasons };
  }

  var checkUrl;
  function showCheck(p, attempts) {
    if (checkUrl) URL.revokeObjectURL(checkUrl);
    checkUrl = URL.createObjectURL(p.blob);
    $('check-img').src = checkUrl;
    var banner = $('check-banner');
    banner.className = 'banner ' + (p.ok ? 'ok' : 'bad');
    $('check-title').textContent = p.ok ? 'Photo is clear' : 'Please retake the photo';
    var ul = $('check-reasons');
    ul.textContent = '';
    (p.ok ? ['Tap the photo to look closer. Can you read all the numbers?'] : p.reasons.map(function (r) { return REASONS[r]; }))
      .forEach(function (txt) { var li = document.createElement('li'); li.textContent = txt; ul.appendChild(li); });
    $('check-score').textContent = 'Sharpness ' + p.sharpness + ' · Light ' + p.brightness;
    $('check-use').hidden = !p.ok;
    $('check-retake').className = 'btn ' + (p.ok ? 'outline' : 'primary');
    $('check-flag').hidden = p.ok || attempts < CFG.allowFlagAfter;
    window.__lastCheck = { sharpness: p.sharpness, brightness: p.brightness, glare: p.glare, ok: p.ok, reasons: p.reasons };
    show('check');
  }

  function acceptPending(flagged) {
    pending.flagged = !!flagged;
    draft.slots[activeSlot.kind].photo = pending;
    pending = null;
    show('capture');
    renderSlots();
    persistDraft();
  }

  function initCheck() {
    $('check-use').addEventListener('click', function () { acceptPending(false); });
    $('check-flag').addEventListener('click', function () { acceptPending(true); });
    $('check-retake').addEventListener('click', function () {
      pending = null;
      show('capture');
      openCamera(activeSlot);
    });
    $('check-img').addEventListener('click', function () {
      if (checkUrl) window.open(checkUrl, '_blank');
    });
  }

  /* ---------------- Save and send ---------------- */

  function saveLoad() {
    var pod = cleanPod($('pod-no').value);
    var odo = Number($('odo').value) || null;
    var d = draft;
    var defs = STAGES[d.stage].photos;
    var photoIds = [];
    var writes = defs.map(function (def) {
      var p = d.slots[def.kind].photo;
      var rec = { id: uid(), loadId: d.id, kind: def.kind, blob: p.blob, sharpness: p.sharpness,
                  flagged: p.flagged, takenAt: p.takenAt, status: 'waiting' };
      photoIds.push(rec.id);
      return store.put('photos', rec);
    });
    var load = { id: d.id, stage: d.stage, podNo: pod, fleetNo: d.fleetNo, odometer: odo, photoIds: photoIds,
                 flagged: defs.filter(function (def) { return d.slots[def.kind].photo.flagged; }).length,
                 gps: d.gps, createdAt: d.createdAt, status: 'waiting' };
    Promise.all(writes).then(function () { return store.put('loads', load); }).then(function () {
      draft = null;
      clearDraft();
      toast(navigator.onLine ? 'Saved. Sending now…' : 'Saved. It will send when you have signal.');
      goHome();
      sync();
    }).catch(function (e) {
      $('capture-error').textContent = 'Could not save on the phone: ' + (e && e.message ? e.message : 'storage full?');
      $('capture-error').hidden = false;
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  var syncing = false;
  function sync() {
    if (syncing) return Promise.resolve();
    syncing = true;
    lastSyncError = '';
    return getSession().then(function (s) {
      if (!s || (!navigator.onLine && !DEMO)) return;
      return store.all('loads').then(function (loads) {
        var todo = loads.filter(function (l) { return l.status !== 'sent'; })
          .sort(function (a, b) { return a.createdAt - b.createdAt; });
        var chain = Promise.resolve();
        todo.forEach(function (load) { chain = chain.then(function () { return sendLoad(s, load); }); });
        return chain;
      });
    }).catch(function (e) {
      lastSyncError = e.message || 'unknown error';
      if (e.code === 'AUTH') { toast(e.message); logout(); }
    }).then(function () {
      syncing = false;
      if (!$('screen-home').hidden) renderHome();
      return cleanup();
    });
  }

  function sendLoad(s, load) {
    var chain = Promise.resolve();
    load.photoIds.forEach(function (pid) {
      chain = chain.then(function () {
        return store.get('photos', pid).then(function (p) {
          if (!p || p.status === 'sent') return;
          return blobToBase64(p.blob).then(function (b64) {
            return api('upload', { token: s.token, photoId: p.id, submissionId: load.id, podNo: load.podNo,
                                   stage: load.stage, kind: p.kind, fleetNo: load.fleetNo, takenAt: p.takenAt,
                                   sharpness: p.sharpness, override: p.flagged, data: b64 });
          }).then(function () {
            p.status = 'sent';
            p.sentAt = Date.now();
            return store.put('photos', p);
          }).then(function () { if (!$('screen-home').hidden) renderHome(); });
        });
      });
    });
    return chain.then(function () {
      return store.get('kv', monthKey());
    }).then(function (bytes) {
      return api('submit', { token: s.token, submission: {
        id: load.id, podNo: load.podNo, stage: load.stage, fleetNo: load.fleetNo, odometer: load.odometer,
        photoCount: load.photoIds.length, flagged: load.flagged, createdAt: load.createdAt,
        lat: load.gps && load.gps.lat, lng: load.gps && load.gps.lng, accuracy: load.gps && load.gps.accuracy,
        workDataMb: +((bytes || 0) / 1048576).toFixed(1) } });
    }).then(function () {
      load.status = 'sent';
      load.sentAt = Date.now();
      return store.put('loads', load);
    });
  }

  /* Frees phone storage: drops the photo files of loads sent more than keepPhotosDays ago. */
  function cleanup() {
    var limit = Date.now() - CFG.keepPhotosDays * 864e5;
    return store.all('photos').then(function (photos) {
      return Promise.all(photos.filter(function (p) { return p.status === 'sent' && p.blob && p.sentAt < limit; })
        .map(function (p) { p.blob = null; return store.put('photos', p); }));
    }).catch(function () {});
  }

  /* ---------------- Load detail and sharing ---------------- */

  var detailFiles = [];
  var detailUrls = [];
  function openDetail(id) {
    store.get('loads', id).then(function (load) {
      if (!load) return;
      return Promise.all(load.photoIds.map(function (pid) { return store.get('photos', pid); })).then(function (photos) {
        detailUrls.forEach(URL.revokeObjectURL);
        detailUrls = [];
        detailFiles = [];
        $('detail-title').textContent = (load.stage === 'loading' ? 'Loading' : 'Offloading') + ' · POD ' + load.podNo;
        $('detail-sub').textContent = load.fleetNo + ' · ' + fmtDate(load.createdAt) + ' · ' + (load.status === 'sent' ? 'Sent' : 'Waiting to send');
        var box = $('detail-photos');
        box.textContent = '';
        var removed = 0;
        photos.forEach(function (p) {
          if (!p || !p.blob) { removed++; return; }
          var u = URL.createObjectURL(p.blob);
          detailUrls.push(u);
          var img = document.createElement('img');
          img.src = u;
          img.alt = p.kind.replace(/_/g, ' ');
          box.appendChild(img);
          detailFiles.push(new File([p.blob], load.podNo + '_' + p.kind + '.jpg', { type: 'image/jpeg' }));
        });
        $('detail-note').textContent = removed ? 'Older photos are removed from the phone to save space. The control room still has them.' : '';
        $('detail-share').hidden = detailFiles.length === 0;
        $('detail-share').setAttribute('data-text', (load.stage === 'loading' ? 'Loading' : 'Offloading') + ' POD ' + load.podNo + ' ' + load.fleetNo);
        show('detail');
      });
    });
  }

  function initDetail() {
    $('detail-back').addEventListener('click', goHome);
    $('detail-share').addEventListener('click', function () {
      var data = { files: detailFiles, text: $('detail-share').getAttribute('data-text') };
      if (navigator.canShare && navigator.canShare({ files: detailFiles })) {
        navigator.share(data).catch(function () {});
      } else {
        toast('Sharing photos is not supported on this phone.');
      }
    });
  }

  /* ---------------- Start ---------------- */

  function start() {
    initLogin();
    initHome();
    initCapture();
    initCheck();
    initDetail();
    window.addEventListener('online', function () { sync(); });
    window.addEventListener('offline', function () { if (!$('screen-home').hidden) renderHome(); });
    setInterval(function () { if (navigator.onLine) sync(); }, 60000);
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    openDb().then(getSession).then(function (s) {
      if (s && s.expires > Date.now()) {
        return store.get('kv', 'draft').then(function (d) {
          if (d && d.slots && STAGES[d.stage]) restoreDraft(d); else goHome();
          sync();
        });
      }
      show('login');
    }).catch(function () {
      document.body.textContent = 'This phone\'s browser cannot store data for the app. Update Chrome and try again.';
    });
  }

  start();
})();
