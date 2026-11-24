// CheerDeck Desktop — the hosted panel in a native window, plus the gift-to-
// keystroke bridge running locally and automatically.
//
// How it works:
//  - Opens cheerdeck.com in a window with a tray icon (close = hide to tray).
//  - Once you're logged in, it reads your account's overlay key from the
//    panel's own API (your session cookie, inside this window) and opens a
//    "companion" WebSocket to the panel. When an Action fires a keystroke,
//    the panel sends it here and we type it into whatever window is focused —
//    so gifts/commands can press keys in your game. No manual pairing.
//  - It only receives key sequences and types them locally; it never sends
//    your input anywhere.
//  - Chat bot (1.3.0+): the panel can hand it a message to post into your TikTok
//    LIVE chat; it types it into TikTok's own chat box in a hidden window that
//    uses your "Sign in with TikTok" login (see "chat bot posting" below).
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PANEL_URL = (process.env.CHEERDECK_URL || 'https://cheerdeck.com').replace(/\/+$/, '');
let win = null;
let tray = null;

// single instance — second launch just focuses the window
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

/* ------------------------- keystroke bridge ------------------------- */
// Same SendKeys logic as the panel's src/keysender.ps1. Written to a temp file
// at startup so the packaged app needs no loose files.
const KEYSENDER_PS1 = `Add-Type -AssemblyName System.Windows.Forms
$sig = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);'
$Mouse = Add-Type -MemberDefinition $sig -Name 'U32Mouse' -Namespace 'CheerDeck' -PassThru
Add-Type -Name FG -Namespace Win -MemberDefinition @'
  [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
# Never type into CheerDeck itself (that creates a feedback loop) — only games.
function ForegroundIsOurs {
  try {
    $h = [Win.FG]::GetForegroundWindow(); $p = 0
    [void][Win.FG]::GetWindowThreadProcessId($h, [ref]$p)
    $n = (Get-Process -Id $p -ErrorAction Stop).ProcessName
    return ($n -eq 'CheerDeck' -or $n -eq 'electron')
  } catch { return $false }
}
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if (ForegroundIsOurs) { [Console]::Out.WriteLine('SKIP'); continue }
    $parts = $line.Split(' ', 2)
    switch ($parts[0]) {
      'KEYS' {
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
        [System.Windows.Forms.SendKeys]::SendWait($text)
      }
      'LCLICK' { $Mouse::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 40; $Mouse::mouse_event(0x0004,0,0,0,0) }
      'RCLICK' { $Mouse::mouse_event(0x0008,0,0,0,0); Start-Sleep -Milliseconds 40; $Mouse::mouse_event(0x0010,0,0,0,0) }
    }
    [Console]::Out.WriteLine('OK')
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message) }
}
`;
let ps = null;
let psPath = null;
function ensureBridge() {
  if (process.platform !== 'win32') return null;
  if (ps && ps.exitCode === null) return ps;
  if (!psPath) {
    psPath = path.join(os.tmpdir(), 'cheerdeck-keysender.ps1');
    try { fs.writeFileSync(psPath, KEYSENDER_PS1); } catch {}
  }
  ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', psPath],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  ps.on('exit', () => { ps = null; });
  return ps;
}
function inject(sequence) {
  const seq = String(sequence || '');
  if (!seq) return;
  const p = ensureBridge();
  if (!p || !p.stdin.writable) return;
  for (const part of seq.split(/(\{MOUSE_CLICK_LEFT\}|\{MOUSE_CLICK_RIGHT\})/i).filter(Boolean)) {
    if (/^\{MOUSE_CLICK_LEFT\}$/i.test(part)) p.stdin.write('LCLICK\n');
    else if (/^\{MOUSE_CLICK_RIGHT\}$/i.test(part)) p.stdin.write('RCLICK\n');
    else p.stdin.write('KEYS ' + Buffer.from(part, 'utf8').toString('base64') + '\n');
  }
}

/* ------------------------- companion socket ------------------------- */
let ws = null;
let wsKey = null;
let backoff = 2000;
let connected = false;

function setConnected(v) {
  if (connected === v) return;
  connected = v;
  updateTray();
}
function wsUrlFor(key) {
  const u = new URL(PANEL_URL);
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${u.host}/ws?role=companion&key=${encodeURIComponent(key)}`;
}
// Reconnection is driven by exactly ONE timer so a dropped socket can never
// spawn several replacements.
let reconnectTimer = null;
function scheduleReconnect(key) {
  if (reconnectTimer || wsKey !== key) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wsKey === key) connectCompanion(key); }, backoff);
  backoff = Math.min(backoff * 1.6, 30000);
}
function connectCompanion(key) {
  if (!key) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }   // never keep two sockets
  let socket;
  try { socket = new WebSocket(wsUrlFor(key), { handshakeTimeout: 15000 }); }
  catch { scheduleReconnect(key); return; }
  ws = socket;
  let settled = false;
  const onDrop = () => {
    if (settled) return; settled = true;
    setConnected(false);
    if (ws === socket) ws = null;
    scheduleReconnect(key);   // guarded: at most one pending reconnect
  };
  socket.on('open', () => { backoff = 2000; setConnected(true); try { socket.send(JSON.stringify({ type: 'hello', client: 'desktop', version: app.getVersion(), caps: ['chat'] })); } catch {} });
  socket.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'keystroke') inject(m.sequence);
    else if (m.type === 'chat:post') {
      postChat(m.username, m.text).then(
        () => { try { socket.send(JSON.stringify({ type: 'chat:result', id: m.id, ok: true })); } catch {} },
        (e) => { try { socket.send(JSON.stringify({ type: 'chat:result', id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 200) })); } catch {} });
    }
  });
  socket.on('close', onDrop);
  socket.on('error', () => { try { socket.close(); } catch {} });
  const hb = setInterval(() => { try { socket.readyState === 1 ? socket.send(JSON.stringify({ type: 'ping' })) : clearInterval(hb); } catch { clearInterval(hb); } }, 30000);
}
// Only (re)connects when the account key changes; the socket's own onDrop owns
// transient reconnects. Guarded against the async race that opened many sockets.
let syncing = false;
async function syncCompanion() {
  if (!win || syncing) return;
  syncing = true;
  try {
    let key = '';
    try {
      key = await win.webContents.executeJavaScript(
        "fetch('/api/status',{credentials:'include'}).then(r=>r.json()).then(s=>s&&s.overlayKey||'').catch(()=>'')", true);
    } catch {}
    if (key && key !== wsKey) {
      wsKey = key;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      backoff = 2000;
      connectCompanion(key);   // closes any existing socket itself
    }
  } finally { syncing = false; }
}

/* ------------------------- TikTok sign-in ------------------------- */
// "Sign in with TikTok": the streamer logs in on TikTok's own page, in a window
// of this app. Once TikTok has set its session cookie, the app copies that
// cookie (and tt-target-idc) into the streamer's CheerDeck settings, so nobody
// has to dig it out of a browser's developer tools.
//  - The password is typed into TikTok's page. This app never reads it; it only
//    reads the two cookies named below.
//  - The cookies are sent to one place: the CheerDeck panel this app is showing,
//    and only while the main window is actually on that site.
//  - The session ID is never written to a log or shown in a notification.
// Started by the panel (window.open('/app/tiktok-signin')) or from the tray.
const TT_LOGIN_URL = process.env.CHEERDECK_TIKTOK_LOGIN_URL || 'https://www.tiktok.com/login';                                   // env: testing
const TT_ACCOUNT_URL = process.env.CHEERDECK_TIKTOK_ACCOUNT_URL || 'https://www.tiktok.com/passport/web/account/info/?aid=1459'; // env: testing
const TT_PARTITION = 'persist:tiktok-signin';   // its own cookie jar, separate from the panel's
let ttWin = null;
let ttTimer = null;
let ttBusy = false;
let ttRejected = '';   // a cookie value TikTok says is not a live login

function onPanel() {
  try { return !!win && new URL(win.webContents.getURL()).host === new URL(PANEL_URL).host; } catch { return false; }
}
function stopTikTokWatch() { if (ttTimer) { clearInterval(ttTimer); ttTimer = null; } }

async function tiktokSignIn(fresh) {
  if (ttWin) { ttWin.show(); ttWin.focus(); return; }
  if (!onPanel()) {
    if (win) { win.show(); win.focus(); }
    notify('Sign in with TikTok', 'Open CheerDeck and log in to your CheerDeck account first, then try again.');
    return;
  }
  const ses = session.fromPartition(TT_PARTITION);
  // TikTok and the sign-in providers it offers turn away browsers that announce
  // themselves as an embedded app, so this window uses the plain Chrome name.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:cheerdeck-desktop|CheerDeck|Electron)\/\S+/gi, ''));
  if (fresh) { try { await ses.clearStorageData(); } catch {} }   // "use a different TikTok account"
  ttRejected = '';
  ttWin = new BrowserWindow({
    width: 540, height: 800, minWidth: 420, minHeight: 600, parent: win || undefined,
    backgroundColor: '#ffffff', autoHideMenuBar: true, title: 'Sign in to TikTok',
    webPreferences: { partition: TT_PARTITION }
  });
  const wc = ttWin.webContents;
  // The title bar always shows which site the window is on.
  const showHost = () => { try { if (ttWin) ttWin.setTitle('Sign in to TikTok — ' + new URL(wc.getURL()).host); } catch {} };
  ttWin.on('page-title-updated', (e) => { e.preventDefault(); showHost(); });
  wc.on('did-navigate', showHost);
  wc.on('did-navigate-in-page', showHost);
  ttWin.on('closed', () => { ttWin = null; stopTikTokWatch(); });
  ttWin.loadURL(TT_LOGIN_URL);
  ttTimer = setInterval(() => checkTikTokLogin(ses), 1500);
}

// Has TikTok logged this window in yet? If so, take the cookies and finish.
async function checkTikTokLogin(ses) {
  if (ttBusy || !ttWin) return;
  ttBusy = true;
  try {
    const origin = new URL(TT_LOGIN_URL).origin;
    const cookie = async (name) => { const c = await ses.cookies.get({ url: origin, name }); return c[0] ? String(c[0].value || '') : ''; };
    const sessionId = await cookie('sessionid');
    if (!sessionId || sessionId === ttRejected) return;
    // A cookie from an old login can linger, so ask TikTok whether this one is
    // live. Only a clear "session expired" counts as no; if TikTok can't be
    // asked, or answers something else, go by the cookie.
    let username = '';
    try {
      const r = await ses.fetch(TT_ACCOUNT_URL, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const d = (j && j.data) || {};
      if (j && j.message === 'error' && (d.name === 'session_expired' || d.error_code === 13)) { ttRejected = sessionId; return; }
      username = String(d.username || '').replace(/[^\w.]/g, '').slice(0, 40);
    } catch {}
    const ttTargetIdc = await cookie('tt-target-idc');
    stopTikTokWatch();
    if (ttWin) ttWin.close();
    await saveTikTokSession(sessionId, ttTargetIdc, username);
  } catch {} finally { ttBusy = false; }
}

// Hand the cookies to the panel, which saves them in the account's settings.
async function saveTikTokSession(sessionId, ttTargetIdc, username) {
  if (!onPanel()) { notify('Sign in with TikTok', 'CheerDeck is not open on your account. Open it, log in, and try again.'); return; }
  const payload = { sessionId };
  if (ttTargetIdc) payload.ttTargetIdc = ttTargetIdc;
  const js = `(async () => {
    const p = ${JSON.stringify(payload)};
    let ok = false;
    try {
      const r = await fetch('/api/settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      ok = !!j && j.sessionId === p.sessionId;
    } catch {}
    try { if (window.cheerdeckTikTokLinked) window.cheerdeckTikTokLinked({ ok, username: ${JSON.stringify(username)} }); } catch {}
    return ok;
  })()`;
  let ok = false;
  try { ok = await win.webContents.executeJavaScript(js, true); } catch {}
  if (win) { win.show(); win.focus(); }
  if (ok) notify('TikTok connected', (username ? 'Signed in as @' + username + '. ' : '') + 'Your TikTok session is saved in CheerDeck.');
  else notify('Could not save your TikTok sign-in', 'Make sure you are logged in to CheerDeck, then try again.');
}

/* ------------------------- chat bot posting ------------------------- */
// The panel's chat bot can post into the streamer's TikTok LIVE chat through
// this app, for free: a hidden window opens the streamer's LIVE page on
// tiktok.com, signed in with the account from "Sign in with TikTok" (same cookie
// jar), types the message into TikTok's own chat box and presses Enter. TikTok's
// page does the rest, exactly as if the streamer typed it.
//  - Only messages the panel sends (chat:post) are typed; nothing is read back
//    except whether the chat box emptied (= TikTok took the message).
//  - The video stream is blocked and the window is muted: no extra bandwidth or sound.
//  - The window closes after 20 minutes without posts.
//  - Tray → "Show TikTok chat window" shows it, e.g. if TikTok asks for a check.
const TT_LIVE_URL = process.env.CHEERDECK_TIKTOK_LIVE_URL || 'https://www.tiktok.com/@{user}/live';   // env: testing
const CHAT_IDLE_MS = 20 * 60 * 1000;
let chatWin = null, chatUser = '', chatIdle = null, chatChain = Promise.resolve(), chatMediaBlock = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tiktokSession() {
  const ses = session.fromPartition(TT_PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:cheerdeck-desktop|CheerDeck|Electron)\/\S+/gi, ''));
  if (!chatMediaBlock) {
    chatMediaBlock = true;
    // Don't download the LIVE video in the hidden chat window (only that window).
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
      const fromChat = chatWin && !chatWin.isDestroyed() && d.webContentsId === chatWin.webContents.id;
      cb({ cancel: !!(fromChat && (d.resourceType === 'media' || /\/\/pull-[^/]*\/|\.flv(\?|$)|\.m3u8(\?|$)/i.test(d.url))) });
    });
  }
  return ses;
}

function closeChatWin() {
  if (chatIdle) { clearTimeout(chatIdle); chatIdle = null; }
  if (chatWin && !chatWin.isDestroyed()) chatWin.destroy();
  chatWin = null; chatUser = ''; updateTray();
}

async function openChatWin(user) {
  if (chatWin && !chatWin.isDestroyed() && chatUser === user) return chatWin.webContents;
  closeChatWin();
  chatWin = new BrowserWindow({
    show: false, width: 1100, height: 820, title: 'CheerDeck: TikTok chat', autoHideMenuBar: true,
    webPreferences: { partition: TT_PARTITION, backgroundThrottling: false }
  });
  chatUser = user;
  chatWin.on('close', (e) => { if (!app.isQuitting && chatWin) { e.preventDefault(); chatWin.hide(); } });   // hide, keep posting
  chatWin.on('closed', () => { chatWin = null; chatUser = ''; updateTray(); });
  chatWin.webContents.setAudioMuted(true);
  chatWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  updateTray();
  try { await chatWin.loadURL(TT_LIVE_URL.replace('{user}', encodeURIComponent(user))); } catch {}   // TikTok keeps loading in the background; the chat box check below waits
  return chatWin.webContents;
}

// Runs inside TikTok's page: finds the chat box (waits for it), and defines the helpers below.
const CHAT_PAGE_JS = `(async () => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 8 && getComputedStyle(el).visibility !== 'hidden'; };
  const hint = (el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-e2e'), el.getAttribute('data-placeholder'), el.className].join(' ').toLowerCase();
  const find = () => {
    const all = [...document.querySelectorAll('[contenteditable="plaintext-only"], [contenteditable="true"], [contenteditable=""], textarea')].filter(visible);
    return all.find(el => /comment|chat|say something|message/.test(hint(el))) || all[all.length - 1] || null;
  };
  const text = (el) => el ? (el.value !== undefined ? el.value : el.textContent || '') : '';
  window.__cdBox = find;
  window.__cdInsert = (msg) => {
    const el = find(); if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, msg); el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false); document.execCommand('delete', false);
      document.execCommand('insertText', false, msg);
    }
    return text(el).trim() === msg.trim();
  };
  window.__cdEmpty = () => { const el = find(); return !el || text(el).trim() === ''; };
  window.__cdEnterFallback = () => {
    const el = find(); if (!el) return;
    const btn = [...document.querySelectorAll('button, [role="button"], [data-e2e]')].filter(visible)
      .find(b => /send|post|comment-post|submit/.test(hint(b)) && b !== el);
    if (btn) { btn.click(); return; }
    for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  };
  for (let i = 0; i < 40; i++) { if (find()) return 'ok'; await new Promise(r => setTimeout(r, 500)); }
  return /login|passport/i.test(location.href) ? 'login' : 'nobox';
})()`;

function postChat(username, text) {
  const run = chatChain.then(() => postChatNow(username, text));
  chatChain = run.catch(() => {});   // one message at a time
  return run;
}

async function postChatNow(username, text) {
  const user = String(username || '').replace(/^@/, '').replace(/[^\w.]/g, '').slice(0, 40);
  const msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!user) throw new Error('No TikTok username is set in CheerDeck (Settings → TikTok Connection).');
  if (!msg) throw new Error('Nothing to send');
  const ses = tiktokSession();
  const signedIn = await ses.cookies.get({ url: new URL(TT_LOGIN_URL).origin, name: 'sessionid' });
  if (!signedIn.length || !signedIn[0].value) throw new Error('The desktop app is not signed in to TikTok. Tray icon → Sign in with TikTok, then try again.');
  const wc = await openChatWin(user);
  const found = await wc.executeJavaScript(CHAT_PAGE_JS, true).catch(() => 'nobox');
  if (found === 'login') throw new Error('TikTok asked the desktop app to log in again. Tray icon → Sign in with TikTok.');
  if (found !== 'ok') throw new Error("Could not find TikTok's chat box on your LIVE page. Are you live? Tray icon → Show TikTok chat window to see what TikTok shows.");
  const typed = await wc.executeJavaScript(`window.__cdInsert(${JSON.stringify(msg)})`, true).catch(() => false);
  if (!typed) throw new Error("Could not type into TikTok's chat box. Tray icon → Show TikTok chat window to see what TikTok shows.");
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(900);
  let sent = await wc.executeJavaScript('window.__cdEmpty()', true).catch(() => false);
  if (!sent) {
    await wc.executeJavaScript('window.__cdEnterFallback()', true).catch(() => {});
    await sleep(900);
    sent = await wc.executeJavaScript('window.__cdEmpty()', true).catch(() => false);
  }
  if (chatIdle) clearTimeout(chatIdle);
  chatIdle = setTimeout(closeChatWin, CHAT_IDLE_MS);
  if (!sent) throw new Error('TikTok did not take the message (it stayed in the chat box). TikTok may be limiting posts for a while.');
}

/* ------------------------- self-update ------------------------- */
// New versions come from the app's GitHub releases (electron-updater reads
// latest.yml from the newest release). An update never interrupts a stream: it
// downloads in the background and installs when the app quits. If the PC was
// shut down before that could happen, it installs at the next launch instead.
let autoUpdater = null;
let updateState = 'idle';        // idle | checking | downloading | ready
let updateVersion = '';
let manualCheck = false;
const UPDATE_DRYRUN = !!process.env.CHEERDECK_UPDATE_DRYRUN;   // testing: download but never install
const pendingFile = () => path.join(app.getPath('userData'), 'pending-update.json');
const updateLogFile = () => path.join(app.getPath('userData'), 'updater.log');
function ulog(msg) {
  try { fs.appendFileSync(updateLogFile(), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
function readPending() {
  try { return String(JSON.parse(fs.readFileSync(pendingFile(), 'utf8')).version || ''); } catch { return ''; }
}
function clearPending() { try { fs.unlinkSync(pendingFile()); } catch {} }
function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch {}
}
function installUpdateNow() {
  if (!autoUpdater || updateState !== 'ready' || UPDATE_DRYRUN) return;
  ulog('installing ' + updateVersion);
  clearPending();
  app.isQuitting = true;                    // let the window really close
  autoUpdater.quitAndInstall(true, true);   // silent install, reopen afterwards
}
function checkForUpdate(manual) {
  if (!autoUpdater || updateState === 'checking' || updateState === 'downloading') return;
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch(() => { /* reported by the 'error' event */ });
}
function initUpdater() {
  if (!app.isPackaged) return;              // nothing to update when run from source
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { ulog('updater unavailable: ' + e.message); return; }
  try { if (fs.statSync(updateLogFile()).size > 200000) fs.unlinkSync(updateLogFile()); } catch {}
  if (process.env.CHEERDECK_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CHEERDECK_UPDATE_URL }); // testing
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = !UPDATE_DRYRUN;
  const pendingAtLaunch = readPending();
  const launchedAt = Date.now();
  ulog(`start v${app.getVersion()}${pendingAtLaunch ? ' (pending ' + pendingAtLaunch + ')' : ''}`);

  autoUpdater.on('checking-for-update', () => { updateState = 'checking'; updateTray(); });
  autoUpdater.on('update-available', (info) => {
    updateState = 'downloading'; updateVersion = info.version;
    ulog('available ' + info.version); updateTray();
  });
  autoUpdater.on('update-not-available', () => {
    updateState = 'idle'; clearPending(); ulog('up to date'); updateTray();
    if (manualCheck) notify('CheerDeck is up to date', 'You have the latest version (' + app.getVersion() + ').');
    manualCheck = false;
  });
  autoUpdater.on('error', (err) => {
    updateState = 'idle';
    ulog('error: ' + String((err && err.message) || err).split('\n')[0].slice(0, 300)); updateTray();
    if (manualCheck) notify('Could not check for updates', 'CheerDeck will try again later.');
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = 'ready'; updateVersion = info.version; manualCheck = false;
    ulog('downloaded ' + info.version); updateTray();
    if (UPDATE_DRYRUN) return;
    // Downloaded in an earlier session but never installed (e.g. the PC was shut
    // down): install it right away at launch, before a stream is under way.
    if (pendingAtLaunch === info.version && Date.now() - launchedAt < 120000) {
      notify('Updating CheerDeck', 'Installing version ' + info.version + '. CheerDeck will reopen in a moment.');
      return installUpdateNow();
    }
    try { fs.writeFileSync(pendingFile(), JSON.stringify({ version: info.version })); } catch {}
    notify('CheerDeck update ready', 'Version ' + info.version + ' installs when you quit CheerDeck. Click here to restart and update now.', installUpdateNow);
  });

  setTimeout(() => checkForUpdate(false), 8000);
  setInterval(() => checkForUpdate(false), 4 * 60 * 60 * 1000);   // the app can sit in the tray for days
}
function updateMenuItem() {
  if (!autoUpdater) return null;
  if (updateState === 'ready') return { label: '⬆ Restart to update to ' + updateVersion, click: installUpdateNow, enabled: !UPDATE_DRYRUN };
  if (updateState === 'downloading') return { label: 'Downloading update ' + updateVersion + '…', enabled: false };
  if (updateState === 'checking') return { label: 'Checking for updates…', enabled: false };
  return { label: 'Check for updates', click: () => checkForUpdate(true) };
}

/* ------------------------- window + tray ------------------------- */
function trayIcon() {
  // The real CheerDeck logo, embedded at tray sizes. build.files ships only
  // main.js, so there is no icon file on disk to load at runtime. Three
  // representations keep the tray icon crisp from 100% to 300% display scaling.
  const png16 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMwSURBVDhPbZJbTFxVFIbXzOHMDDNT5kIHmQFkkHuNl+ncHCrMUG3UUApFLrUtyRRtglETn4jY+AKpRkhlEEqpAUKxF5toYmtjjU1NH/RVX0x8sGBifGlyjg+toZ4+nM/MwURt3cmf7LWz17f/9WeLaZo/m6apFWbntFznHi2ZbtdSmayWavuXMlktnc5qj8czWjq7W5spfKgVe0zTvCmGYdw+NDyCiCCiIuJExHGfSnjJ3cTpihyNErTuHjh0BMMw7sjU9IxWPChx+BDVi6Juw+cM4nMFKXMGcTsDVImb5bIUl6qe47tQF61qpQV5f/oDXdJtOa34sk3dRsJbyzd1ffxWN8xGZJBfKgf5vmqAgd5RevpHuezPcd3dyaw7jYiNVCarSyzRphVt+9QAP1b380NwH6+WtvKmbyd5idLmrseVfwVZO8PgWwXOKDHy7hZrtCcTGV3iyactBy2uCH8EB0mUhC177xRmWLh4gWBN1KrtvodQr17DE6hBFLcFiCd3/QNodUW45e0l6YhYDSsraxSXYdxjV6YDm9OP7fMvkcoo9v8DNDnD/O7q4zHHVkDnTi9z6+Y6b+SPErA5UdQylC++RqmIoiie+wEOgmqQDaWXVWmjtbKJ9MRxHh47hjzfg71nAJmdR258i1LitfQAwKF4yYUSnAy/yFPHTlBx9jP8Fy+jXruB+tV1Ap9eoWzvQeyBCIr9gRHsOMINyPBR5NcNXJNT/CQ5Lkka+9kLlFy5yifyBOu+/QS6DiKecutzWYBYPGN9JDU/iif7At6eIZpHXmO/p4me5g4iI6O4u/sZ3HOAw0ot5V1D2J7ttnKKxTO6JIuAiii+6Tm2+2porH2UI/NLuLZXkzj8Mt2vj1Htq2JoYQl/XSvlDTFKJ6YQu5Nkql2X45PvWRn4T60SXvyY0NwK7sU1QoWP8M+v4FlYpfzEIq6Tq5TPLRNaOk/pxLTlYHLyXV027969va+7DykGk+hEUruRnVkk9cxWHf97H+tAkp1IrB0Rhb3dfWxubt4R0zTXDeOe/vbYuL6joVmPVtXp9TUNW6pt/I8eqa7XdzS26ONj4/qfhqEXe/8CJyrEuNcq7hwAAAAASUVORK5CYII=';
  const png32 = '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';
  const png48 = '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';
  const img = nativeImage.createFromBuffer(Buffer.from(png16, 'base64'));
  try {
    img.addRepresentation({ scaleFactor: 2, width: 16, height: 16, buffer: Buffer.from(png32, 'base64') });
    img.addRepresentation({ scaleFactor: 3, width: 16, height: 16, buffer: Buffer.from(png48, 'base64') });
  } catch (e) {}
  return img;
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip('CheerDeck — keystrokes: ' + (connected ? 'connected' : 'not connected'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? '● Keystrokes: connected' : '○ Keystrokes: not connected', enabled: false },
    { type: 'separator' },
    { label: 'Open CheerDeck', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: 'Open in browser', click: () => shell.openExternal(PANEL_URL) },
    { label: 'Sign in with TikTok…', click: () => tiktokSignIn(false) },
    chatWin ? { label: 'Show TikTok chat window', click: () => { if (chatWin) { chatWin.show(); chatWin.focus(); } } } : null,
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Version ' + app.getVersion(), enabled: false },
    updateMenuItem(),
    { label: 'Quit CheerDeck', click: () => { app.isQuitting = true; app.quit(); } }
  ].filter(Boolean)));
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0e14', autoHideMenuBar: true, title: 'CheerDeck',
    webPreferences: { partition: 'persist:cheerdeck' } // keeps you logged in across restarts
  });
  win.loadURL(PANEL_URL);
  // open overlay "Test" links and other off-site links in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.host !== new URL(PANEL_URL).host) { shell.openExternal(url); return { action: 'deny' }; }
      // The panel's "Sign in with TikTok" button.
      if (u.pathname === '/app/tiktok-signin') { tiktokSignIn(u.searchParams.get('fresh') === '1'); return { action: 'deny' }; }
    } catch {}
    return { action: 'allow' };
  });
  win.webContents.on('did-finish-load', () => { syncCompanion(); });
  win.webContents.on('did-navigate', () => { syncCompanion(); });
  // close = hide to tray (keeps keystrokes working); real quit from the tray
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.cheerdeck.desktop');   // so Windows shows our notifications
  createWindow();
  tray = new Tray(trayIcon());
  initUpdater();
  updateTray();
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  // re-check the login/key every 30s in case they log in later
  setInterval(syncCompanion, 30000);
});
app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', () => { app.isQuitting = true; try { if (ps) ps.kill(); } catch {} });
