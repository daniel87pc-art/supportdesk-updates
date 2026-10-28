// ניהול לקוחות - the phone app.
// It is one more "computer" of the program's sync: it reads the computers' encrypted files (<id>.sdsync) from the
// Google Drive sync folder, shows the clients, stations and treatments, and writes ONE file of its own
// (m-<id>.sdsync) with only what was done on the phone (treatments, calls, connections). The computers take it in
// at their next sync (about a minute). No server: the phone talks to Google Drive directly.
'use strict';
const CFG = window.SD_CONFIG || {};
const APP_VERSION = CFG.version || 'dev';
const $app = document.getElementById('app');
const TABLES = ['clients', 'system_types', 'solutions', 'passwords', 'vpn_profiles', 'quick_connects', 'phonebook',
  'stations', 'contacts', 'links', 'log', 'attachments', 'personal', 'sticky_notes', 'tickets'];
const CENTER_CAT = 'מוקד';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// ================================================================== small helpers
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const localNow = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const newUid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const digits = s => String(s || '').replace(/\D/g, '');
function intl(phone) {
  let d = digits(phone);
  if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}
function parseTime(s) {                       // "YYYY-MM-DD HH:MM[:SS]" (local) -> Date
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/);
  if (!m) { const m2 = String(s).match(/(\d{4})-(\d\d)-(\d\d)/); return m2 ? new Date(+m2[1], m2[2] - 1, +m2[3]) : null; }
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}
function when(s) {                            // a short Hebrew date for lists
  const d = parseTime(s); if (!d) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return 'היום ' + hm;
  if (diff === -1) return 'אתמול ' + hm;
  if (diff === 1) return 'מחר ' + hm;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() !== today.getFullYear() ? '/' + String(d.getFullYear()).slice(2) : ''} ${hm}`;
}
function overdueText(s) {
  const d = parseTime(s); if (!d) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const n = Math.round((today - day) / 86400000);
  if (n <= 0) return d < new Date() ? 'באיחור' : '';
  return n === 1 ? 'מאתמול' : n === 2 ? 'לפני יומיים' : `באיחור של ${n} ימים`;
}
let toastTimer = null;
function toast(text, action, fn, ms = 4500) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<div style="flex:1">${esc(text)}</div>` + (action ? `<button class="btn small">${esc(action)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.remove(); fn && fn(); };
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} הועתק`); }
  catch (e) { prompt('העתקה:', text); }
}

// ================================================================== storage (IndexedDB, this phone only)
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('supportdesk', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const s = t.objectStore('kv'); const r = fn(s);
      t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
    clear: () => tx('readwrite', s => s.clear()),
  };
})();

// ================================================================== state
const S = {
  setup: null,          // {mode: 'drive'|'files', folderId, folderName, deviceId, deviceName, myFileId}
  key: null,            // the sync key (raw bytes), while the app is open
  files: {},            // other devices' files: {fileId: {name, modified, bytes}}
  mine: {},             // rows changed on this phone: {"tbl|uid": {tbl, uid, ver, row?, del?}}
  data: null,           // merged view: {tables: {tbl: Map(uid -> row)}, extras, devices: [...]}
  token: null,          // Google access token {v, exp}
  syncing: false, lastSync: null, syncError: '', dirty: false,
  license: null, unlocked: false,
};

async function loadState() {
  S.setup = await idb.get('setup') || null;
  S.files = await idb.get('files') || {};
  S.mine = await idb.get('mine') || {};
  S.token = await idb.get('token') || null;
  S.lastSync = await idb.get('lastSync') || null;
  S.dirty = !!(await idb.get('dirty'));
}

// ================================================================== the merged data
function verOf(item) { return item && item.ver || ''; }
async function rebuild() {
  const best = {};                                 // tbl -> uid -> item (newest)
  const pcVers = {};                               // "tbl|uid" -> the newest version the other devices have
  const devices = [];
  let extras = null, extrasTime = '';
  for (const id of Object.keys(S.files)) {
    const f = S.files[id];
    let data;
    try { data = await SDCrypto.openFile(f.bytes, S.key); } catch (e) { f.bad = true; continue; }
    f.bad = false;
    if (data.device === (S.setup && S.setup.deviceId)) continue;
    devices.push({ name: data.name || '?', time: data.time || '', phone: String(data.device || '').startsWith('m-') });
    if (data.extras && (data.time || '') >= extrasTime) { extras = data.extras; extrasTime = data.time || ''; }
    for (const t of Object.keys(data.tables || {})) {
      const m = best[t] || (best[t] = {});
      for (const it of data.tables[t]) {
        if (verOf(it) > verOf(m[it.uid])) m[it.uid] = it;
        const k = t + '|' + it.uid;
        if (verOf(it) > (pcVers[k] || '')) pcVers[k] = verOf(it);
      }
    }
  }
  for (const k of Object.keys(S.mine)) {           // this phone's own changes (if newer)
    const it = S.mine[k];
    const m = best[it.tbl] || (best[it.tbl] = {});
    if (verOf(it) > verOf(m[it.uid])) m[it.uid] = it;
  }
  const tables = {};
  for (const t of TABLES) {
    const map = new Map();
    for (const [uid, it] of Object.entries(best[t] || {})) if (!it.del && it.row) map.set(uid, it.row);
    tables[t] = map;
  }
  S.data = { tables, extras: extras || {}, devices, pcVers };
  await checkLicense();
}
const T = name => (S.data ? S.data.tables[name] : new Map());
function clients() {
  return [...T('clients').values()].filter(c => !c.deleted_at)
    .sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.favorite || 0) - (a.favorite || 0) || String(a.name).localeCompare(String(b.name), 'he'));
}
const byClient = (tbl, cuid) => [...T(tbl).values()].filter(r => r.client_id === cuid);
function openItems() {
  const out = [];
  for (const r of T('log').values()) {
    if (r.status !== 'open') continue;
    const c = T('clients').get(r.client_id);
    if (!c || c.deleted_at) continue;
    out.push({ src: 'log', row: r, client: c });
  }
  for (const r of T('personal').values()) if (r.status === 'open') out.push({ src: 'personal', row: r, client: null });
  out.sort((a, b) => ((a.row.followup ? 0 : 1) - (b.row.followup ? 0 : 1)) || String(a.row.followup || '').localeCompare(String(b.row.followup || '')) || String(a.row.created).localeCompare(String(b.row.created)));
  return out;
}
const isOverdue = r => { const d = parseTime(r.followup); return d && d < new Date(); };

// ================================================================== changes made on the phone
function ver() { return new Date().toISOString().replace('Z', '') + '|' + S.setup.deviceId; }
async function saveRow(tbl, row) {
  S.mine[tbl + '|' + row.uid] = { tbl, uid: row.uid, ver: ver(), row };
  await idb.set('mine', S.mine);
  S.dirty = true; await idb.set('dirty', true);
  await rebuild();
  scheduleSync();
}
let syncSoon = null;
function scheduleSync() { clearTimeout(syncSoon); syncSoon = setTimeout(() => sync(false), 2500); }

async function addLog(clientUid, fields) {
  const now = localNow();
  const row = Object.assign({ uid: newUid(), client_id: clientUid, station_id: null, kind: 'note', text: '', status: 'done',
    followup: null, created: now, updated: now, color: '', reminded: null }, fields);
  await saveRow('log', row);
  return row;
}
async function updateRow(tbl, row, fields) {
  const r = Object.assign({}, row, fields);
  if ('updated' in row || tbl === 'log' || tbl === 'personal') r.updated = localNow();
  if (tbl !== 'tickets' && fields.followup !== undefined && fields.followup !== row.followup) r.reminded = null;
  await saveRow(tbl, r);
  return r;
}

// ================================================================== the license (the program's own - from the computer)
async function checkLicense() {
  const code = (S.data && S.data.extras && S.data.extras.license) || '';
  if (!code) { S.license = { ok: false, reason: S.data && S.data.devices.length ? 'missing' : 'nodata' }; return; }
  S.license = await SDCrypto.checkLicense(code, CFG.publicKey || '');
}
function licenseText(l) {
  return {
    missing: 'עדיין לא התקבל רישיון מהמחשב. ודא שבמחשב מותקנת גרסה 3.48 ומעלה והסנכרון פועל.',
    nodata: 'עדיין אין נתונים מהמחשב.',
    invalid: 'הרישיון של התוכנה אינו תקין.',
    expired: `תוקף הרישיון של התוכנה הסתיים (${l && l.expires || ''}).`,
    nokey: 'האפליקציה פורסמה בלי מפתח רישוי.',
    unsupported: 'הדפדפן בטלפון ישן מדי לבדיקת הרישיון - עדכן את Chrome.',
  }[l && l.reason] || '';
}

// ================================================================== Google Drive
let gisLoaded = null;
function loadGis() {
  return gisLoaded || (gisLoaded = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => { gisLoaded = null; rej(new Error('אין חיבור לגוגל')); };
    document.head.appendChild(s);
  }));
}
function tokenValid() { return S.token && S.token.v && S.token.exp > Date.now() + 60000; }
async function getToken(interactive) {
  if (tokenValid()) return S.token.v;
  if (!interactive) return null;
  if (!CFG.googleClientId) throw new Error('החיבור לגוגל דרייב עוד לא הוגדר באפליקציה');
  await loadGis();
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: CFG.googleClientId,
      scope: 'https://www.googleapis.com/auth/drive',
      hint: (S.setup && S.setup.email) || undefined,
      callback: async r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        S.token = { v: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        await idb.set('token', S.token);
        res(S.token.v);
      },
      error_callback: e => rej(new Error(e && e.type === 'popup_closed' ? 'החלון נסגר' : 'ההתחברות לגוגל לא הושלמה')),
    });
    tc.requestAccessToken({ prompt: S.setup && S.setup.folderId ? '' : 'consent' });
  });
}
async function drive(path, opts = {}, base = DRIVE) {
  const tok = await getToken(false);
  if (!tok) throw Object.assign(new Error('צריך להתחבר שוב לגוגל'), { login: true });
  const r = await fetch(base + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, opts.headers || {}) }));
  if (r.status === 401) { S.token = null; await idb.del('token'); throw Object.assign(new Error('צריך להתחבר שוב לגוגל'), { login: true }); }
  if (!r.ok) throw new Error('Google Drive: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}
const q = s => encodeURIComponent(s);
async function findSyncFolders() {
  const r = await (await drive(`/files?q=${q("name contains '.sdsync' and trashed = false")}&fields=${q('files(id,name,parents,modifiedTime)')}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
  const folders = {};
  for (const f of r.files || []) for (const p of f.parents || []) {
    const e = folders[p] || (folders[p] = { id: p, count: 0, latest: '' });
    e.count++; if (f.modifiedTime > e.latest) e.latest = f.modifiedTime;
  }
  const out = Object.values(folders);
  for (const f of out) {
    try { f.name = (await (await drive(`/files/${f.id}?fields=name&supportsAllDrives=true`)).json()).name; }
    catch (e) { f.name = 'תיקייה'; }
  }
  return out.sort((a, b) => b.latest.localeCompare(a.latest));
}

// one sync: download what changed, merge, upload this phone's file when it has news
async function sync(interactive) {
  if (S.syncing || !S.setup || !S.key) return;
  if (S.setup.mode !== 'drive') { await rebuild(); render(); return; }
  S.syncing = true; S.syncError = ''; renderTop();
  try {
    if (!tokenValid()) await getToken(interactive);
    if (!tokenValid()) throw Object.assign(new Error('צריך להתחבר לגוגל'), { login: true });
    const list = await (await drive(`/files?q=${q(`'${S.setup.folderId}' in parents and trashed = false and name contains '.sdsync'`)}&fields=${q('files(id,name,modifiedTime,size)')}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
    const seen = new Set();
    for (const f of list.files || []) {
      if (!f.name.endsWith('.sdsync') || f.name.endsWith('.tmp')) continue;
      if (f.name === S.setup.deviceId + '.sdsync') { S.setup.myFileId = f.id; continue; }
      seen.add(f.id);
      const have = S.files[f.id];
      if (have && have.modified === f.modifiedTime) continue;
      const bytes = new Uint8Array(await (await drive(`/files/${f.id}?alt=media&supportsAllDrives=true`)).arrayBuffer());
      S.files[f.id] = { name: f.name, modified: f.modifiedTime, bytes };
    }
    for (const id of Object.keys(S.files)) if (!seen.has(id)) delete S.files[id];
    await idb.set('files', S.files);
    await rebuild();
    prune();
    if (S.dirty || !S.setup.myFileId) await upload();
    S.lastSync = new Date().toISOString(); await idb.set('lastSync', S.lastSync);
    await idb.set('setup', S.setup);
  } catch (e) {
    S.syncError = e.login ? 'login' : (e.message || String(e));
  } finally {
    S.syncing = false;
    render();
  }
}
// rows the computers already took in (they have this version or a newer one): no need to send them any more
function prune() {
  const pv = (S.data && S.data.pcVers) || {};
  let changed = false;
  for (const [k, it] of Object.entries(S.mine)) {
    if ((pv[k] || '') >= it.ver) { delete S.mine[k]; changed = true; }
  }
  if (changed) idb.set('mine', S.mine);
}
function myPayload() {
  const tables = {};
  for (const it of Object.values(S.mine)) {
    (tables[it.tbl] || (tables[it.tbl] = [])).push(it.del ? { uid: it.uid, ver: it.ver, del: 1 } : { uid: it.uid, ver: it.ver, row: it.row });
  }
  return { v: 1, device: S.setup.deviceId, name: S.setup.deviceName || 'טלפון', time: new Date().toISOString().replace('Z', ''), tables };
}
async function upload() {
  const blob = await SDCrypto.makeFile(myPayload(), S.key);
  const name = S.setup.deviceId + '.sdsync';
  if (S.setup.myFileId) {
    await drive(`/files/${S.setup.myFileId}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }, UPLOAD);
  } else {
    const meta = { name, parents: [S.setup.folderId] };
    const bnd = 'sd' + newUid();
    const head = `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bnd}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const body = new Blob([head, blob, `\r\n--${bnd}--`]);
    const r = await (await drive(`/files?uploadType=multipart&supportsAllDrives=true&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + bnd }, body }, UPLOAD)).json();
    S.setup.myFileId = r.id;
  }
  S.dirty = false; await idb.set('dirty', false);
  await idb.set('setup', S.setup);
}

// ================================================================== the lock (an optional PIN on this phone)
async function sha(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function wrapKey(pin) {                      // the sync key, kept locked with the PIN (or plain without one)
  if (!pin) { await idb.set('key', { plain: [...S.key] }); return; }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, S.key));
  await idb.set('key', { salt: [...salt], iv: [...iv], ct: [...ct] });
}
async function unwrapKey(pin) {
  const w = await idb.get('key');
  if (!w) return null;
  if (w.plain) return new Uint8Array(w.plain);
  if (!pin) return 'pin';
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(w.salt), iterations: 200000, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(w.iv) }, k, new Uint8Array(w.ct))); }
  catch (e) { return 'bad'; }
}

// ================================================================== screens
let route = location.hash.slice(1) || '/';
window.addEventListener('hashchange', () => { route = location.hash.slice(1) || '/'; render(); window.scrollTo(0, 0); });
const go = r => { location.hash = r; };
let searchText = '';

function syncLabel() {
  if (!S.setup || S.setup.mode !== 'drive') return S.setup ? 'קבצים' : '';
  if (S.syncing) return '<span class="spin">⟳</span> מסנכרן';
  if (S.syncError === 'login') return '🔑 התחבר';
  if (S.syncError) return '⚠ סנכרון';
  if (!tokenValid()) return '⟳ סנכרן';
  return S.lastSync ? '✓ ' + when(S.lastSync.replace('T', ' ')).replace('היום ', '') : '⟳';
}
function renderTop() { const b = document.querySelector('.sync-btn'); if (b) b.innerHTML = syncLabel(); }
function topBar(title, back) {
  return `<div class="top">${back ? `<button class="back" onclick="history.back()" aria-label="חזרה">→</button>` : ''}<h1>${esc(title)}</h1>` +
    (S.setup ? `<button class="sync-btn" onclick="App.syncTap()">${syncLabel()}</button>` : '') + '</div>';
}
function nav(on) {
  const n = openItems().filter(i => isOverdue(i.row)).length;
  const a = (r, i, t, b) => `<a href="#${r}" class="${on === r ? 'on' : ''}"><span class="i">${i}</span>${t}${b ? `<span class="badge">${b}</span>` : ''}</a>`;
  return `<nav class="nav">${a('/', '👥', 'לקוחות')}${a('/open', '🔔', 'פתוחים', n || '')}${a('/settings', '⚙️', 'הגדרות')}</nav>`;
}
function banners() {
  let h = '';
  if (S.syncError === 'login') h += `<div class="banner">החיבור לגוגל פג. <button class="btn small" onclick="App.syncTap()">התחברות</button></div>`;
  else if (S.syncError) h += `<div class="banner red">${esc(S.syncError)}</div>`;
  if (S.setup && S.setup.mode === 'files') h += `<div class="banner">מצב קבצים: מה שנרשם כאן עובר למחשב רק דרך "ייצוא" בהגדרות.</div>`;
  return h;
}

function render() {
  if (!S.setup) return renderSetup();
  if (!S.unlocked) return renderLock();
  if (S.license && !S.license.ok && S.license.reason !== 'nodata' && S.license.reason !== 'missing') return renderLicense();
  const parts = route.split('/');
  if (parts[1] === 'c' && parts[2]) return renderClient(decodeURIComponent(parts[2]));
  if (parts[1] === 'open') return renderOpen();
  if (parts[1] === 'settings') return renderSettings();
  return renderClients();
}

// ---- clients
function renderClients() {
  const list = clients();
  const words = searchText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const stations = [...T('stations').values()];
  const match = c => {
    if (!words.length) return true;
    const hay = [c.name, c.address, c.system, c.contact_name, c.contact_phone, digits(c.contact_phone),
      ...stations.filter(s => s.client_id === c.uid).flatMap(s => [s.name, s.anydesk_id, digits(s.anydesk_id)])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  };
  const shown = list.filter(match);
  let h = topBar('ניהול לקוחות') + `<div class="wrap">${banners()}
    <input class="search" type="search" placeholder="חיפוש לקוח, עמדה, טלפון או מספר AnyDesk" value="${esc(searchText)}" oninput="App.search(this.value)" id="q">`;
  if (S.license && S.license.reason === 'missing') h += `<div class="banner">${esc(licenseText(S.license))}</div>`;
  if (!list.length) h += `<div class="empty">${S.data && S.data.devices.length ? 'אין לקוחות' : 'עדיין אין נתונים מהמחשב - לחץ על הסנכרון למעלה'}</div>`;
  h += `<div class="card">` + shown.slice(0, 300).map(c => {
    const n = byClient('stations', c.uid).length;
    const open = byClient('log', c.uid).filter(r => r.status === 'open').length;
    return `<div class="row tap" onclick="App.go('/c/${encodeURIComponent(c.uid)}')"><div class="main"><div class="t">${c.pinned ? '📌 ' : c.favorite ? '⭐ ' : ''}${esc(c.name)}</div>
      <div class="s">${esc([c.system, n ? (n === 1 ? 'עמדה אחת' : n + ' עמדות') : '', c.address].filter(Boolean).join(' · '))}</div></div>
      ${open ? `<span class="chip warn">${open} פתוחים</span>` : ''}</div>`;
  }).join('') + `</div>`;
  if (shown.length > 300) h += `<div class="hint">מוצגים 300 ראשונים - צמצם בחיפוש</div>`;
  h += `</div><button class="fab" onclick="App.newCall()">+ קריאה חדשה</button>` + nav('/');
  $app.innerHTML = h;
  const qi = document.getElementById('q');
  if (qi && document.activeElement !== qi && searchText) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}

// ---- open treatments / reminders
function renderOpen() {
  const items = openItems();
  const over = items.filter(i => isOverdue(i.row)), rest = items.filter(i => !isOverdue(i.row));
  const row = i => `<div class="row tap" onclick="App.editItem('${i.src}','${i.row.uid}')"><div class="main">
      <div class="t">${esc(i.client ? i.client.name : 'כללי')}</div><div class="s">${esc(String(i.row.text || '').split('\n')[0])}</div></div>
      ${i.row.followup ? `<span class="chip ${isOverdue(i.row) ? 'red' : ''}">${esc(isOverdue(i.row) ? overdueText(i.row.followup) || when(i.row.followup) : when(i.row.followup))}</span>` : ''}</div>`;
  let h = topBar('טיפולים ותזכורות פתוחים') + `<div class="wrap">${banners()}`;
  if (!items.length) h += `<div class="empty">✓ אין טיפולים פתוחים</div>`;
  if (over.length) h += `<div class="card"><h2 style="color:var(--danger)">באיחור (${over.length})</h2>${over.map(row).join('')}</div>`;
  if (rest.length) h += `<div class="card"><h2>פתוחים (${rest.length})</h2>${rest.map(row).join('')}</div>`;
  h += `</div><button class="fab" onclick="App.newCall()">+ קריאה חדשה</button>` + nav('/open');
  $app.innerHTML = h;
}

// ---- one client
function renderClient(uid) {
  const c = T('clients').get(uid);
  if (!c) { $app.innerHTML = topBar('לקוח', true) + `<div class="wrap"><div class="empty">הלקוח לא נמצא</div></div>` + nav(''); return; }
  const stations = byClient('stations', uid).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const people = [];
  if (c.contact_name || c.contact_phone) people.push({ name: c.contact_name, phone: c.contact_phone, role: 'איש קשר ראשי', email: c.contact_email });
  for (const k of byClient('contacts', uid).sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    if (!people.some(p => (p.name || '') === (k.name || '') && digits(p.phone) === digits(k.phone))) people.push(k);   // not twice
  }
  const links = byClient('links', uid).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const log = byClient('log', uid).filter(r => r.kind !== 'memo')
    .sort((a, b) => ((a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)) || String(b.created).localeCompare(String(a.created)));
  const memos = byClient('log', uid).filter(r => r.kind === 'memo');
  const phone = people.find(p => p.phone);
  let h = topBar(c.name, true) + `<div class="wrap">${banners()}`;
  if (c.system || c.address) h += `<div class="hint" style="margin:4px 2px">${esc([c.system, c.address].filter(Boolean).join(' · '))}</div>`;
  h += `<div class="actions">
    <button class="btn solid" onclick="App.treatment('${uid}')"><span class="i">📝</span>רישום טיפול</button>
    <button class="btn" onclick="App.treatment('${uid}', true)"><span class="i">📂</span>קריאה פתוחה</button>
    <button class="btn" onclick="App.center('${uid}')"><span class="i">🎧</span>קריאה במוקד</button>
    ${phone ? `<button class="btn wa" onclick="App.whatsapp('${esc(phone.phone)}')"><span class="i">💬</span>וואטסאפ</button>
    <a class="btn" href="tel:${esc(digits(phone.phone))}"><span class="i">📞</span>חיוג</a>` : ''}
    ${c.address ? `<a class="btn" target="_blank" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}"><span class="i">📍</span>ניווט</a>` : ''}
  </div>`;
  if (stations.length) {
    h += `<div class="card"><h2>עמדות</h2>` + stations.map(s => {
      const app = (s.app || 'anydesk');
      return `<div class="row"><div class="main"><div class="t">${esc(s.name || 'עמדה')}</div>
        <div class="s"><span class="ltr mono">${esc(s.anydesk_id || s.ip || '')}</span>${app !== 'anydesk' ? ' · ' + esc(app) : ''}${s.location ? ' · ' + esc(s.location) : ''}</div>
        ${s.password ? `<div class="s pw" onclick="this.textContent=this.textContent.includes('•')?${esc(JSON.stringify('סיסמה: ' + s.password))}:'סיסמה: ••••••'">סיסמה: ••••••</div>` : ''}</div>
        ${s.anydesk_id ? `<button class="btn small solid" onclick="App.connect('${s.uid}')">התחבר</button>` : ''}
        <button class="btn small" onclick="App.stationMenu('${s.uid}')">⋯</button></div>`;
    }).join('') + `</div>`;
  }
  if (people.length) {
    h += `<div class="card"><h2>אנשי קשר</h2>` + people.map(p => `<div class="row"><div class="main"><div class="t">${esc(p.name || p.phone)}</div>
      <div class="s">${esc([p.role, p.phone].filter(Boolean).join(' · '))}</div></div>
      ${p.phone ? `<a class="btn small" href="tel:${esc(digits(p.phone))}">📞</a><button class="btn small wa" onclick="App.whatsapp('${esc(p.phone)}')">💬</button>` : ''}</div>`).join('') + `</div>`;
  }
  h += `<div class="card"><h2>יומן טיפולים</h2>` + (log.length ? log.slice(0, 60).map(r => `<div class="row tap" onclick="App.editItem('log','${r.uid}')"><div class="main">
      <div class="s">${esc(when(r.created))}${r.kind === 'connect' ? ' · התחברות' : ''}${r.followup ? ' · תזכורת ' + esc(when(r.followup)) : ''}</div>
      <div class="s wrap-text" style="color:var(--ink)">${esc(r.text)}</div></div>
      ${r.status === 'open' ? `<span class="chip ${isOverdue(r) ? 'red' : 'warn'}">פתוח</span>` : ''}</div>`).join('') : `<div class="row"><div class="s">אין רישומים</div></div>`) + `</div>`;
  if (links.length) {
    h += `<div class="card"><h2>קישורים וסיסמאות</h2>` + links.map(l => `<div class="row"><div class="main"><div class="t">${esc(l.name || l.url)}</div>
      <div class="s">${esc([l.username, l.url].filter(Boolean).join(' · '))}</div></div>
      ${l.url ? `<a class="btn small" target="_blank" href="${esc(/^https?:/i.test(l.url) ? l.url : 'https://' + l.url)}">פתח</a>` : ''}
      ${l.username ? `<button class="btn small" onclick="App.copy(${esc(JSON.stringify(l.username))},'שם המשתמש')">👤</button>` : ''}
      ${l.password ? `<button class="btn small" onclick="App.copy(${esc(JSON.stringify(l.password))},'הסיסמה')">🔑</button>` : ''}</div>`).join('') + `</div>`;
  }
  const notes = [c.notes, c.extra_info, ...memos.map(m => m.text)].filter(Boolean);
  if (notes.length) h += `<div class="card"><h2>הערות</h2>${notes.map(n => `<div class="row"><div class="s wrap-text" style="color:var(--ink)">${esc(n)}</div></div>`).join('')}</div>`;
  h += `</div>` + nav('');
  $app.innerHTML = h;
}

// ---- settings
function renderSettings() {
  const st = S.setup;
  const l = S.license;
  let h = topBar('הגדרות') + `<div class="wrap">${banners()}<div class="card"><h2>סנכרון</h2>`;
  if (st.mode === 'drive') {
    h += `<div class="row"><div class="main"><div class="t">${esc(st.folderName || 'תיקיית הסנכרון')}</div><div class="s">Google Drive${st.email ? ' · ' + esc(st.email) : ''}</div></div>
      <button class="btn small solid" onclick="App.syncTap()">סנכרון עכשיו</button></div>
      <div class="row"><div class="main"><div class="s">סנכרון אחרון: ${S.lastSync ? esc(when(S.lastSync.replace('T', ' '))) : 'עדיין לא'}${S.dirty ? ' · יש שינויים שעוד לא נשלחו' : ''}</div></div></div>`;
  } else {
    h += `<div class="row"><div class="main"><div class="t">מצב קבצים (בלי גוגל דרייב)</div><div class="s">נטענו ${Object.keys(S.files).length} קבצים</div></div>
      <button class="btn small" onclick="App.pickFiles()">טעינה מחדש</button></div>
      <div class="row"><div class="main"><div class="s">${Object.keys(S.mine).length} שינויים מהטלפון</div></div>
      <button class="btn small solid" onclick="App.exportMine()">ייצוא</button></div>`;
  }
  for (const d of (S.data ? S.data.devices : [])) h += `<div class="row"><div class="main"><div class="t">${d.phone ? '📱' : '💻'} ${esc(d.name)}</div><div class="s">עדכון אחרון: ${esc(when((d.time || '').replace('T', ' ')))}</div></div></div>`;
  h += `</div><div class="card"><h2>רישיון</h2><div class="row"><div class="main"><div class="t">${l && l.ok ? '✓ בתוקף' : 'לא בתוקף'}</div>
    <div class="s">${l && l.ok ? 'עד ' + esc(l.expires) + (l.daysLeft < 30 ? ` (עוד ${l.daysLeft} ימים)` : '') : esc(licenseText(l))}</div></div></div></div>
    <div class="card"><h2>הטלפון הזה</h2>
    <div class="row"><div class="main"><div class="t">שם המכשיר</div><div class="s">${esc(st.deviceName || '')}</div></div><button class="btn small" onclick="App.rename()">שינוי</button></div>
    <div class="row"><div class="main"><div class="t">קוד נעילה</div><div class="s">${S.hasPin ? 'מוגדר - נדרש בכל פתיחה' : 'לא מוגדר'}</div></div>
      <button class="btn small" onclick="App.setPin()">${S.hasPin ? 'שינוי / הסרה' : 'הגדרה'}</button></div>
    <div class="row"><div class="main"><div class="t">התנתקות</div><div class="s">מחיקת כל המידע מהטלפון (במחשב לא נמחק כלום)</div></div>
      <button class="btn small red" onclick="App.logout()">התנתק</button></div></div>
    <div class="hint" style="text-align:center;margin-top:16px">ניהול לקוחות · אפליקציית טלפון · גרסה ${esc(APP_VERSION)}</div></div>` + nav('/settings');
  $app.innerHTML = h;
}

function renderLicense() {
  $app.innerHTML = `<div class="hero"><img class="logo" src="icon-192.png" alt=""><h2>האפליקציה נעולה</h2><p>${esc(licenseText(S.license))}</p>
    <p class="hint" style="margin-top:10px">הרישיון מגיע מהתוכנה במחשב. אחרי חידוש הרישיון במחשב - סנכרון.</p>
    <div style="margin-top:18px"><button class="btn solid" onclick="App.syncTap()">סנכרון</button></div></div>`;
}

// ---- the lock screen
async function renderLock() {
  $app.innerHTML = `<div class="hero"><img class="logo" src="icon-192.png" alt=""><h2>ניהול לקוחות</h2><p>הקש את קוד הנעילה</p></div>
    <div class="pin"><input id="pin" class="in" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></div>
    <div style="text-align:center"><button class="btn solid" style="min-width:160px" id="unlock">פתיחה</button></div>`;
  const inp = document.getElementById('pin');
  const tryIt = async () => {
    const k = await unwrapKey(inp.value);
    if (k === 'bad' || !k || k === 'pin') { inp.value = ''; toast('קוד שגוי'); return; }
    S.key = k; S.unlocked = true; await rebuild(); render(); sync(false);
  };
  document.getElementById('unlock').onclick = tryIt;
  inp.onkeydown = e => { if (e.key === 'Enter') tryIt(); };
  setTimeout(() => inp.focus(), 50);
}

// ---- first setup
const setupState = { step: 'start', folders: null, err: '' };
function renderSetup() {
  const s = setupState;
  let h = `<div class="hero"><img class="logo" src="icon-192.png" alt=""><h2>ניהול לקוחות בטלפון</h2>
    <p>הלקוחות, העמדות והטיפולים מהתוכנה במחשב - דרך תיקיית הסנכרון ב-Google Drive.</p></div><div class="wrap">`;
  if (s.err) h += `<div class="banner red">${esc(s.err)}</div>`;
  if (s.step === 'start') {
    h += CFG.googleClientId
      ? `<button class="btn solid block" onclick="App.setupLogin()">התחברות ל-Google Drive</button>
         <p class="hint">התחבר עם חשבון הגוגל שבו נמצאת תיקיית הסנכרון של התוכנה (במחשב: הגדרות ← סנכרון בין מחשבים).</p>`
      : `<div class="banner">החיבור לגוגל דרייב עוד לא הוגדר באפליקציה.</div>`;
    h += `<button class="btn block" style="margin-top:10px" onclick="App.pickFiles()">פתיחת קבצי סנכרון מהטלפון</button>
      <p class="hint">בלי חיבור לגוגל: בוחרים את הקבצים <b>*.sdsync</b> מתיקיית הסנכרון. מתאים לבדיקה.</p>`;
  } else if (s.step === 'folders') {
    h += `<div class="card"><h2>באיזו תיקייה נמצא הסנכרון?</h2>` + (s.folders.length ? s.folders.map(f => `<div class="row tap" onclick="App.setupFolder('${f.id}')">
      <div class="main"><div class="t">📁 ${esc(f.name)}</div><div class="s">${f.count} מחשבים · עודכן ${esc(when(f.latest.replace('T', ' ').slice(0, 16)))}</div></div></div>`).join('')
      : `<div class="row"><div class="s">לא נמצאה תיקיית סנכרון בחשבון הזה. ודא שהסנכרון מופעל במחשב, ושהתיקייה משותפת עם החשבון הזה.</div></div>`) + `</div>
      <button class="btn block" onclick="App.setupLogin(true)">חשבון אחר</button>`;
  } else if (s.step === 'code') {
    h += `<label class="f">קוד הסנכרון (אותו קוד שהוגדר בתוכנה במחשב)</label>
      <input id="code" class="in" type="password" autocomplete="off">
      <label class="f">שם לטלפון הזה (יופיע בתוכנה)</label><input id="dname" class="in" value="${esc(s.dname || 'הטלפון של ' + (s.user || ''))}">
      <button class="btn solid block" style="margin-top:16px" id="go">המשך</button>
      <p class="hint" id="wait"></p>`;
  }
  h += `</div>`;
  $app.innerHTML = h;
  if (s.step === 'code') {
    document.getElementById('go').onclick = () => App.setupCode(document.getElementById('code').value, document.getElementById('dname').value);
    setTimeout(() => document.getElementById('code').focus(), 50);
  }
}

// ================================================================== sheets (forms)
function sheet(html, onReady) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.onclick = e => { if (e.target === bg) close(); };
  const close = () => { bg.remove(); window.removeEventListener('popstate', close); };
  document.body.appendChild(bg);
  history.pushState({ sheet: 1 }, '');
  window.addEventListener('popstate', close);
  const done = () => { if (bg.isConnected) history.back(); };
  onReady && onReady(bg.querySelector('.sheet'), done);
  return done;
}
function dtLocal(s) { const d = parseTime(s); return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
function fromDtLocal(v) { return v ? v.replace('T', ' ').slice(0, 16) : null; }
function quickTime(kind) {
  const d = new Date();
  if (kind === 'hour') d.setHours(d.getHours() + 1);
  if (kind === 'eve') { d.setHours(18, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
  if (kind === 'tom') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// a treatment / a call (new, or an existing log row)
function treatmentSheet(clientUid, row, openDefault) {
  const c = clientUid ? T('clients').get(clientUid) : null;
  const stations = clientUid ? byClient('stations', clientUid) : [];
  let status = row ? row.status : (openDefault ? 'open' : 'done');
  sheet(`<h3>${row ? 'עריכת רישום' : openDefault ? 'קריאה חדשה' : 'רישום טיפול'}${c ? ' · ' + esc(c.name) : ''}</h3>
    <label class="f">${openDefault && !row ? 'מה התקלה?' : 'מה טופל?'}</label>
    <textarea id="tx" class="in" placeholder="לדוגמה: הוחלף כבל HDMI במסך 3">${esc(row ? row.text : '')}</textarea>
    ${stations.length ? `<label class="f">עמדה (לא חובה)</label><select id="st" class="in"><option value="">—</option>${stations.map(s => `<option value="${s.uid}" ${row && row.station_id === s.uid ? 'selected' : ''}>${esc(s.name || s.anydesk_id)}</option>`).join('')}</select>` : ''}
    <label class="f">מצב</label><div class="seg" id="seg"><button data-v="open">פתוח</button><button data-v="done">טופל</button></div>
    <label class="f">תזכורת (לא חובה)</label><input id="fu" class="in" type="datetime-local" value="${esc(row ? dtLocal(row.followup) : '')}">
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><button class="btn small" data-q="hour">בעוד שעה</button><button class="btn small" data-q="eve">הערב 18:00</button><button class="btn small" data-q="tom">מחר 09:00</button><button class="btn small" data-q="">בלי</button></div>
    <div class="btns"><button class="btn solid" id="save">שמירה</button>${row ? `<button class="btn" id="del-close">${row.status === 'open' ? '✓ סגירה' : 'פתיחה מחדש'}</button>` : ''}</div>`,
  (el, done) => {
    const seg = el.querySelector('#seg');
    const paint = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === status));
    seg.onclick = e => { if (e.target.dataset.v) { status = e.target.dataset.v; paint(); } };
    paint();
    el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { el.querySelector('#fu').value = b.dataset.q ? quickTime(b.dataset.q) : ''; if (b.dataset.q) { status = 'open'; paint(); } });
    const save = async (forceStatus) => {
      const text = el.querySelector('#tx').value.trim();
      if (!text && !row) { toast('כתוב מה טופל'); return; }
      const fu = fromDtLocal(el.querySelector('#fu').value);
      const st = el.querySelector('#st') ? el.querySelector('#st').value || null : (row ? row.station_id : null);
      const fields = { text, status: forceStatus || status, followup: fu, station_id: st };
      if (row) await updateRow('log', row, fields); else await addLog(clientUid, fields);
      done(); render();
      toast(row ? 'נשמר' : (fields.status === 'open' ? 'הקריאה נפתחה' : 'הטיפול נרשם'));
    };
    el.querySelector('#save').onclick = () => save();
    const dc = el.querySelector('#del-close');
    if (dc) dc.onclick = () => save(row.status === 'open' ? 'done' : 'open');
    setTimeout(() => el.querySelector('#tx').focus(), 80);
  });
}
// a general reminder (not of a client)
function personalSheet(row) {
  sheet(`<h3>תזכורת כללית</h3><div class="s wrap-text" style="white-space:pre-wrap;margin-bottom:8px">${esc(row.text)}</div>
    <label class="f">תזכורת</label><input id="fu" class="in" type="datetime-local" value="${esc(dtLocal(row.followup))}">
    <div class="btns"><button class="btn solid" id="close">✓ סגירה</button><button class="btn" id="save">שמירת המועד</button></div>`,
  (el, done) => {
    el.querySelector('#close').onclick = async () => { await updateRow('personal', row, { status: 'done' }); done(); render(); toast('נסגר'); };
    el.querySelector('#save').onclick = async () => { await updateRow('personal', row, { followup: fromDtLocal(el.querySelector('#fu').value) }); done(); render(); };
  });
}
// pick a client (for "+ קריאה חדשה")
function pickClient(then) {
  sheet(`<h3>לאיזה לקוח?</h3><input id="pq" class="search" type="search" placeholder="חיפוש לקוח"><div class="card" id="pl" style="max-height:55vh;overflow:auto"></div>`,
    (el, done) => {
      const fill = () => {
        const w = el.querySelector('#pq').value.trim().toLowerCase();
        el.querySelector('#pl').innerHTML = clients().filter(c => !w || String(c.name).toLowerCase().includes(w) || digits(c.contact_phone).includes(digits(w) || '~')).slice(0, 80)
          .map(c => `<div class="row tap" data-u="${c.uid}"><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.address || '')}</div></div></div>`).join('') || '<div class="row"><div class="s">לא נמצא</div></div>';
      };
      el.querySelector('#pq').oninput = fill;
      el.querySelector('#pl').onclick = e => { const r = e.target.closest('[data-u]'); if (r) { done(); setTimeout(() => then(r.dataset.u), 120); } };
      fill();
      setTimeout(() => el.querySelector('#pq').focus(), 80);
    });
}
// a call to a technical support center (like "פתיחת קריאה" in the program): the message opens in WhatsApp
function centerSheet(clientUid) {
  const c = T('clients').get(clientUid);
  const centers = [...T('phonebook').values()].filter(r => r.category === CENTER_CAT && r.phone);
  const people = [];
  if (c.contact_name || c.contact_phone) people.push([c.contact_name, c.contact_phone]);
  for (const k of byClient('contacts', clientUid)) if (k.name || k.phone) people.push([k.name, k.phone]);
  if (!centers.length) { toast('אין מוקדים - מוסיפים במחשב: ספר טלפונים, קטגוריה "מוקד"'); return; }
  sheet(`<h3>פתיחת קריאה במוקד · ${esc(c.name)}</h3>
    <label class="f">שליחה אל</label><select id="ce" class="in">${centers.map(r => `<option value="${r.uid}">${esc(r.name)} · ${esc(r.phone)}</option>`).join('')}</select>
    <label class="f">כתובת</label><input id="ad" class="in" value="${esc(c.address || '')}">
    <label class="f">איש קשר לתקלה</label><select id="pp" class="in">${people.map((p, i) => `<option value="${i}">${esc(p.filter(Boolean).join(' · '))}</option>`).join('')}<option value="-1">ללא</option></select>
    <label class="f">מה התקלה?</label><textarea id="ds" class="in"></textarea>
    <label class="f">ההודעה</label><textarea id="msg" class="in" style="min-height:150px"></textarea>
    <div class="btns"><button class="btn wa" id="send">שליחה בוואטסאפ</button></div>
    <p class="hint">נפתח וואטסאפ עם ההודעה - רק ללחוץ "שלח". הקריאה נרשמת ביומן הלקוח.</p>`,
  (el, done) => {
    const build = () => {
      const d = new Date();
      const lines = ['*פתיחת קריאה*', `*תאריך:* ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`, `*לקוח:* ${c.name}`];
      const ad = el.querySelector('#ad').value.trim(); if (ad) lines.push(`*כתובת:* ${ad}`);
      const p = people[+el.querySelector('#pp').value]; if (p) lines.push(`*איש קשר:* ${p.filter(Boolean).join(' · ')}`);
      const ds = el.querySelector('#ds').value.trim(); if (ds) lines.push('', '*תיאור התקלה:*', ds);
      const sign = (S.data.extras.signature || '').trim(); if (sign) lines.push('', sign);
      el.querySelector('#msg').value = lines.join('\n');
    };
    ['#ad', '#pp', '#ds'].forEach(s => el.querySelector(s).addEventListener('input', build));
    build();
    el.querySelector('#send').onclick = async () => {
      const center = T('phonebook').get(el.querySelector('#ce').value);
      const text = el.querySelector('#msg').value.trim();
      const ds = el.querySelector('#ds').value.trim();
      const p = people[+el.querySelector('#pp').value];
      const now = localNow();
      await saveRow('tickets', { uid: newUid(), created: now, client_id: clientUid, client_name: c.name, center_name: center.name,
        center_phone: center.phone, contact: p ? p.filter(Boolean).join(' · ') : '', address: el.querySelector('#ad').value.trim(),
        description: ds, message: text, sent: 1 });
      await addLog(clientUid, { text: `נפתחה קריאה מול ${center.name}` + (ds ? `:\n${ds}` : '') });
      done(); render();
      location.href = `https://wa.me/${intl(center.phone)}?text=${encodeURIComponent(text)}`;
    };
  });
}
function whatsappSheet(phone) {
  const replies = (S.data.extras.replies || []).filter(Boolean);
  const open = text => { location.href = `https://wa.me/${intl(phone)}` + (text ? `?text=${encodeURIComponent(text)}` : ''); };
  if (!replies.length) return open('');
  sheet(`<h3>וואטסאפ · ${esc(phone)}</h3><div class="card">
    <div class="row tap" data-i="-1"><div class="main"><div class="t">פתיחת הצ'אט</div></div></div>
    ${replies.map((r, i) => `<div class="row tap" data-i="${i}"><div class="main"><div class="s wrap-text" style="color:var(--ink)">${esc(r)}</div></div></div>`).join('')}</div>`,
  (el, done) => {
    el.onclick = e => { const r = e.target.closest('[data-i]'); if (!r) return; const i = +r.dataset.i; done(); open(i < 0 ? '' : replies[i]); };
  });
}

// ================================================================== connecting (AnyDesk on the phone)
async function connect(stUid) {
  const s = T('stations').get(stUid);
  if (!s) return;
  const id = digits(s.anydesk_id) || s.anydesk_id;
  if (s.password) { try { await navigator.clipboard.writeText(s.password); } catch (e) { /* the sheet shows it */ } }
  await addLog(s.client_id, { kind: 'connect', text: `התחברות מהטלפון${s.name ? ' · ' + s.name : ''}`, station_id: stUid });
  let left = false;
  const onHide = () => { if (document.visibilityState === 'hidden') left = true; };
  document.addEventListener('visibilitychange', onHide);
  location.href = 'anydesk:' + id;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (left) return;
    sheet(`<h3>התחברות · ${esc(s.name || '')}</h3>
      <p>אם AnyDesk לא נפתח לבד: פתח אותו, הדבק את המספר, ואת הסיסמה כשהיא נדרשת.</p>
      <div class="card"><div class="row"><div class="main"><div class="s">מספר</div><div class="t ltr mono">${esc(s.anydesk_id)}</div></div><button class="btn small" id="cid">העתק</button></div>
      ${s.password ? `<div class="row"><div class="main"><div class="s">סיסמה</div><div class="t ltr mono">${esc(s.password)}</div></div><button class="btn small" id="cpw">העתק</button></div>` : ''}</div>
      <div class="btns"><a class="btn solid" href="intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.anydesk.anydeskandroid;end">פתיחת AnyDesk</a></div>`,
    el => {
      el.querySelector('#cid').onclick = () => copy(s.anydesk_id, 'המספר');
      const p = el.querySelector('#cpw'); if (p) p.onclick = () => copy(s.password, 'הסיסמה');
    });
  }, 1600);
  if (s.password) toast('הסיסמה הועתקה - להדבקה ב-AnyDesk');
}
function stationMenu(stUid) {
  const s = T('stations').get(stUid);
  sheet(`<h3>${esc(s.name || 'עמדה')}</h3><div class="card">
    ${s.anydesk_id ? `<div class="row tap" id="a"><div class="main"><div class="t">העתקת המספר</div><div class="s ltr mono">${esc(s.anydesk_id)}</div></div></div>` : ''}
    ${s.password ? `<div class="row tap" id="b"><div class="main"><div class="t">העתקת הסיסמה</div></div></div>` : ''}
    ${s.username ? `<div class="row tap" id="u"><div class="main"><div class="t">העתקת שם המשתמש</div><div class="s">${esc(s.username)}</div></div></div>` : ''}
    <div class="row tap" id="t"><div class="main"><div class="t">רישום טיפול לעמדה הזו</div></div></div>
    ${s.notes ? `<div class="row"><div class="s wrap-text" style="color:var(--ink)">${esc(s.notes)}</div></div>` : ''}</div>`,
  (el, done) => {
    const on = (id, fn) => { const x = el.querySelector(id); if (x) x.onclick = () => { done(); fn(); }; };
    on('#a', () => copy(s.anydesk_id, 'המספר')); on('#b', () => copy(s.password, 'הסיסמה')); on('#u', () => copy(s.username, 'שם המשתמש'));
    on('#t', () => setTimeout(() => { treatmentSheet(s.client_id, null, false); setTimeout(() => { const sel = document.querySelector('#st'); if (sel) sel.value = s.uid; }, 50); }, 150));
  });
}

// ================================================================== actions (called from the screens)
const App = {
  go, copy,
  search(v) { searchText = v; clearTimeout(App._st); App._st = setTimeout(renderClients, 120); },
  syncTap() { sync(true); },
  treatment(uid, open) { treatmentSheet(uid, null, !!open); },
  newCall() { pickClient(uid => treatmentSheet(uid, null, true)); },
  center: centerSheet,
  whatsapp: whatsappSheet,
  connect, stationMenu,
  editItem(src, uid) {
    if (src === 'personal') return personalSheet(T('personal').get(uid));
    const r = T('log').get(uid);
    if (r) treatmentSheet(r.client_id, r);
  },
  async rename() {
    const n = prompt('שם לטלפון הזה (יופיע בתוכנה במחשב):', S.setup.deviceName || '');
    if (n === null) return;
    S.setup.deviceName = n.trim() || S.setup.deviceName; await idb.set('setup', S.setup);
    S.dirty = true; await idb.set('dirty', true); render(); scheduleSync();
  },
  async setPin() {
    const p = prompt(S.hasPin ? 'קוד נעילה חדש (ריק = בלי קוד):' : 'קוד נעילה (4 ספרות ומעלה):', '');
    if (p === null) return;
    if (p && p.length < 4) { toast('לפחות 4 ספרות'); return; }
    if (p && prompt('שוב, לאישור:', '') !== p) { toast('הקודים לא זהים'); return; }
    await wrapKey(p); S.hasPin = !!p; render(); toast(p ? 'קוד הנעילה נשמר' : 'הקוד הוסר');
  },
  async logout() {
    if (!confirm('למחוק את כל המידע מהטלפון? (במחשב לא נמחק כלום)' + (S.dirty ? '\n\nשים לב: יש שינויים שעוד לא נשלחו למחשב.' : ''))) return;
    await idb.clear(); location.hash = ''; location.reload();
  },
  // ---- setup
  async setupLogin(other) {
    setupState.err = '';
    try {
      if (other) { S.token = null; await idb.del('token'); }
      await getToken(true);
      $app.innerHTML = `<div class="hero"><span class="spin" style="font-size:28px">⟳</span><p>מחפש את תיקיית הסנכרון…</p></div>`;
      try { const me = await (await drive('/about?fields=user(emailAddress,displayName)')).json(); setupState.email = me.user.emailAddress; setupState.user = me.user.displayName; } catch (e) { /* not needed */ }
      setupState.folders = await findSyncFolders();
      setupState.step = 'folders';
      if (setupState.folders.length === 1) return App.setupFolder(setupState.folders[0].id);
    } catch (e) { setupState.err = e.message || String(e); setupState.step = 'start'; }
    renderSetup();
  },
  setupFolder(id) {
    const f = setupState.folders.find(x => x.id === id);
    setupState.folder = f; setupState.step = 'code'; renderSetup();
  },
  async setupCode(code, dname) {
    if (!code.trim()) { toast('הקלד את קוד הסנכרון'); return; }
    const w = document.getElementById('wait'); if (w) w.textContent = 'בודק…';
    const key = await SDCrypto.deriveKey(code);
    S.key = key;
    if (setupState.files) {                        // files mode: the chosen files must open with this code
      let ok = 0;
      for (const f of Object.values(setupState.files)) { try { await SDCrypto.openFile(f.bytes, key); ok++; } catch (e) { /* another code */ } }
      if (!ok) { setupState.err = 'קוד הסנכרון שגוי'; S.key = null; return renderSetup(); }
      S.files = setupState.files;
      S.setup = { mode: 'files', deviceId: 'm-' + newUid().slice(0, 10), deviceName: dname.trim() || 'טלפון' };
    } else {
      S.setup = { mode: 'drive', folderId: setupState.folder.id, folderName: setupState.folder.name, email: setupState.email || '',
        deviceId: 'm-' + newUid().slice(0, 10), deviceName: dname.trim() || 'טלפון' };
      S.files = {};
      try {
        S.syncing = false;
        const list = await (await drive(`/files?q=${q(`'${S.setup.folderId}' in parents and trashed = false and name contains '.sdsync'`)}&fields=${q('files(id,name,modifiedTime)')}&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
        let ok = 0, bad = 0;
        for (const f of list.files || []) {
          const bytes = new Uint8Array(await (await drive(`/files/${f.id}?alt=media&supportsAllDrives=true`)).arrayBuffer());
          try { await SDCrypto.openFile(bytes, key); ok++; S.files[f.id] = { name: f.name, modified: f.modifiedTime, bytes }; } catch (e) { bad++; }
        }
        if (!ok) { setupState.err = bad ? 'קוד הסנכרון שגוי' : 'אין עדיין קבצי סנכרון בתיקייה'; S.setup = null; S.key = null; return renderSetup(); }
      } catch (e) { setupState.err = e.message || String(e); S.setup = null; S.key = null; return renderSetup(); }
    }
    await idb.set('setup', S.setup); await idb.set('files', S.files);
    await wrapKey('');
    S.unlocked = true; S.dirty = true; await idb.set('dirty', true);
    await rebuild();
    location.hash = '/'; render();
    if (S.setup.mode === 'drive') sync(false);
  },
  pickFiles() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.sdsync,application/octet-stream';
    inp.onchange = async () => {
      const files = {};
      for (const f of inp.files) if (f.name.endsWith('.sdsync')) files['file:' + f.name] = { name: f.name, modified: String(f.lastModified), bytes: new Uint8Array(await f.arrayBuffer()) };
      if (!Object.keys(files).length) { toast('לא נבחרו קבצי ‎.sdsync'); return; }
      if (S.setup && S.key) {                      // loading newer files later
        for (const [k, v] of Object.entries(files)) if (!v.name.startsWith(S.setup.deviceId)) S.files[k] = v;
        await idb.set('files', S.files); await rebuild(); render(); toast('נטען'); return;
      }
      setupState.files = files; setupState.step = 'code'; setupState.err = ''; renderSetup();
    };
    inp.click();
  },
  async exportMine() {
    const blob = await SDCrypto.makeFile(myPayload(), S.key);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' })); a.download = S.setup.deviceId + '.sdsync';
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    toast('שים את הקובץ בתיקיית הסנכרון - המחשב יקלוט אותו בסנכרון הבא');
  },
};
window.App = App;

// ================================================================== start
(async function start() {
  await loadState();
  const w = await idb.get('key');
  S.hasPin = !!(w && !w.plain);
  if (S.setup) {
    const k = await unwrapKey('');
    if (k instanceof Uint8Array) { S.key = k; S.unlocked = true; await rebuild(); }
  }
  render();
  if (S.unlocked && S.setup && S.setup.mode === 'drive') sync(false);
  setInterval(() => { if (document.visibilityState === 'visible' && S.unlocked && tokenValid()) sync(false); }, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.unlocked && tokenValid()) sync(false); });
  // a new version of the app (published from the computer's build): offer to reload
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {   // a new version took over
      if (!had || reloading) return;
      reloading = true;
      if (document.querySelector('.sheet-bg')) toast('גרסה חדשה של האפליקציה', 'רענון', () => location.reload(), 60000);
      else location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 3600000);
    }).catch(() => {});
  }
})();
