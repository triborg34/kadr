const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { scryptSync, timingSafeEqual, createHmac, randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const MAX_CONNECTIONS = 2;
const MAX_BODY = 300 * 1024;
const MAX_CAPTION_BYTES = 256 * 1024;
const users = {
  triborg: { password: process.env.TRIBORG_PASSWORD, salt: 'kadar-user-triborg-v1' },
  kimiblue: { password: process.env.KIMIBLUE_PASSWORD, salt: 'kadar-user-kimiblue-v1' },
};
for (const [username, account] of Object.entries(users)) {
  if (!account.password || account.password.length < 12) {
    console.error(`Set ${username === 'triborg' ? 'TRIBORG_PASSWORD' : 'KIMIBLUE_PASSWORD'} to a password of at least 12 characters.`);
    process.exit(1);
  }
  account.salt = process.env[`KADAR_${username.toUpperCase()}_SALT`];
  if (!account.salt) {
    console.error(`Set KADAR_${username.toUpperCase()}_SALT to a random value and keep it persistent in the server environment.`);
    process.exit(1);
  }
  account.hash = scryptSync(account.password, account.salt, 32);
  delete account.password;
}
const turnUrls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
const turnSecret = process.env.TURN_SECRET || '';
if (turnUrls.some((url) => !/^turns?:[^\s]+$/i.test(url))) {
  console.error('TURN_URLS must contain comma-separated turn: or turns: URLs.');
  process.exit(1);
}
if (turnUrls.length && turnSecret.length < 32) {
  console.error('Set TURN_SECRET to a random secret of at least 32 characters when TURN_URLS is configured.');
  process.exit(1);
}
const authFailures = new Map();
const revokedSessions = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.KADAR_SESSION_SECRET || '';
if (sessionSecret.length < 32) {
  console.error('Set KADAR_SESSION_SECRET to a persistent random secret of at least 32 characters.');
  process.exit(1);
}
const clients = new Map();
const playRoom = { film: null, playing: false, position: 0, subtitle: null };
const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(payload));
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(data).digest('base64url');
  return `${data}.${signature}`;
}
function readSessionToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [data, signature, ...extra] = token.split('.');
  if (!data || !signature || extra.length) return null;
  const expected = createHmac('sha256', sessionSecret).update(data).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  if (!['triborg', 'kimiblue'].includes(payload.username) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
  return payload;
}
function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = isSecureRequest(req) ? cookies['__Host-kadar_session'] : cookies.kadar_session;
  const session = readSessionToken(token);
  if (!session) return null;
  if (revokedSessions.has(token)) return null;
  return { token, ...session };
}
function requestOriginMatches(req) {
  try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}
function isSecureRequest(req) {
  return req.socket.encrypted === true || req.headers['x-forwarded-proto'] === 'https';
}
function serverAddress(req) {
  const address = req.socket.remoteAddress || 'unknown';
  return /^[a-f0-9:.]+$/i.test(address) ? address : 'unknown';
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function sessionCookie(token, secure, clear = false) {
  const name = secure ? '__Host-kadar_session' : 'kadar_session';
  return `${name}=${clear ? '' : token}; Path=/; Max-Age=${clear ? 0 : SESSION_TTL / 1000}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
function validLogin(username, password) {
  if (!['triborg', 'kimiblue'].includes(username) || typeof password !== 'string' || password.length > 256) return false;
  const account = users[username];
  const providedHash = scryptSync(password, account.salt, 32);
  return timingSafeEqual(account.hash, providedHash);
}
const server = http.createServer(async (req, res) => {
  if (req.url?.split('?')[0] === '/api/subtitle' && req.method === 'GET') {
    if (!sessionFromRequest(req)) return sendJson(res, 401, { error: 'ورود لازم است.' });
    if (!playRoom.subtitle) return sendJson(res, 404, { error: 'زیرنویسی انتخاب نشده است.' });
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'content-length': Buffer.byteLength(playRoom.subtitle.vtt, 'utf8'), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(playRoom.subtitle.vtt);
  }
  if (req.url === '/api/session' && req.method === 'GET') {
    const session = sessionFromRequest(req);
    return session
      ? sendJson(res, 200, { username: session.username, expiresAt: session.expiresAt })
      : sendJson(res, 401, { error: 'ورود لازم است.' });
  }
  if (req.url === '/api/login' && req.method === 'POST') {
    if (!requestOriginMatches(req)) return sendJson(res, 403, { error: 'درخواست ورود معتبر نیست.' });
    if (isSecureRequest(req) && req.headers['x-forwarded-host'] && req.headers['x-forwarded-host'] !== req.headers.host) return sendJson(res, 403, { error: 'درخواست ورود معتبر نیست.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { error: 'درخواست ورود معتبر نیست.' });
    const address = serverAddress(req);
    const failures = authFailures.get(address);
    if (failures && Date.now() < failures.until && failures.count >= 6) return sendJson(res, 429, { error: 'ورودهای ناموفق زیاد بود؛ ۱۵ دقیقهٔ دیگر تلاش کن.' });
    let payload;
    try { payload = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'اطلاعات ورود معتبر نیست.' }); }
    if (!validLogin(payload.username, payload.password)) {
      const now = Date.now();
      const previous = authFailures.get(address);
      const record = previous && now < previous.until ? previous : { count: 0, until: now + 15 * 60 * 1000 };
      record.count += 1;
      authFailures.set(address, record);
      return sendJson(res, record.count >= 6 ? 429 : 401, { error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    authFailures.delete(address);
    const expiresAt = Date.now() + SESSION_TTL;
    const token = signSession({ username: payload.username, expiresAt, nonce: randomBytes(16).toString('base64url') });
    return sendJson(res, 200, { username: payload.username, expiresAt }, { 'set-cookie': sessionCookie(token, isSecureRequest(req)) });
  }
  if (req.url === '/api/logout' && req.method === 'POST') {
    if (!requestOriginMatches(req)) return sendJson(res, 403, { error: 'درخواست خروج معتبر نیست.' });
    const session = sessionFromRequest(req);
    if (session) {
      revokedSessions.set(session.token, session.expiresAt);
      const client = clients.get(session.username);
      if (client?.sessionToken === session.token) client.close(1000, 'Logged out');
    }
    return sendJson(res, 200, { ok: true }, { 'set-cookie': [sessionCookie('', true, true), sessionCookie('', false, true)] });
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, users: clients.size, uptime: Math.round(process.uptime()) }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  const relativePath = path.relative(ROOT, filePath).split(path.sep).join('/');
  const isPublicAsset = relativePath.startsWith('assets/') && !relativePath.split('/').some((part) => part.startsWith('.'));
  if (!filePath.startsWith(ROOT + path.sep) || (!publicFiles.has(relativePath) && !isPublicAsset)) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = {
      'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=300',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filePath).pipe(res);
  });
});
server.requestTimeout = 10000;
server.headersTimeout = 12000;
server.keepAliveTimeout = 5000;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function getPublicState() {
  return { ...playRoom, subtitle: playRoom.subtitle ? { name: playRoom.subtitle.name, updatedAt: playRoom.subtitle.updatedAt } : null, users: [...clients.keys()] };
}
function getIceServers(username) {
  if (!turnUrls.length || !turnSecret) return [];
  const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const turnUsername = `${expiry}:${username}`;
  const credential = createHmac('sha1', turnSecret).update(turnUsername).digest('base64');
  return [{ urls: turnUrls, username: turnUsername, credential }];
}
function broadcastState() {
  const state = getPublicState();
  for (const ws of clients.values()) send(ws, { type: 'state', state });
}
function validPosition(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60 * 60 * 24 * 30; }
function validSignal(message) {
  if (message.signalType === 'hangup') return true;
  if (message.signalType === 'offer' || message.signalType === 'answer') {
    const desc = message.description;
    return desc && desc.type === message.signalType && typeof desc.sdp === 'string' && desc.sdp.length > 0 && desc.sdp.length <= 16000;
  }
  if (message.signalType === 'candidate') {
    const c = message.candidate;
    return c === null || (c && typeof c.candidate === 'string' && c.candidate.length <= 2048 && (c.sdpMid == null || typeof c.sdpMid === 'string'));
  }
  return false;
}
function handleMessage(ws, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { send(ws, { type: 'error', message: 'پیام نامعتبر است.' }); return; }
  if (!ws.username) { ws.close(1008, 'Login required'); return; }
  if (message.type === 'playback') {
    if (ws.username !== 'triborg') { send(ws, { type: 'error', message: 'فقط مدیر اتاق می‌تواند پخش را کنترل کند.' }); return; }
    if (typeof message.playing !== 'boolean' || !validPosition(message.position)) return;
    playRoom.playing = message.playing;
    playRoom.position = message.position;
    broadcastState();
    return;
  }
  if (message.type === 'subtitle') {
    if (ws.username !== 'triborg') { send(ws, { type: 'error', message: 'فقط مدیر اتاق می‌تواند زیرنویس انتخاب کند.' }); return; }
    if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 120 || typeof message.vtt !== 'string' || !message.vtt.startsWith('WEBVTT\n') || Buffer.byteLength(message.vtt, 'utf8') > MAX_CAPTION_BYTES) {
      send(ws, { type: 'error', message: 'فایل زیرنویس معتبر نیست یا حجم آن بیش از حد مجاز است.' }); return;
    }
    playRoom.subtitle = { name: message.name.trim(), vtt: message.vtt, updatedAt: Date.now() };
    broadcastState();
    return;
  }
  if (message.type === 'clear-subtitle') {
    if (ws.username !== 'triborg') { send(ws, { type: 'error', message: 'فقط مدیر اتاق می‌تواند زیرنویس را حذف کند.' }); return; }
    playRoom.subtitle = null;
    broadcastState();
    return;
  }
  if (message.type === 'publish') {
    if (ws.username !== 'triborg') { send(ws, { type: 'error', message: 'فقط مدیر اتاق می‌تواند فیلم انتخاب کند.' }); return; }
    if (typeof message.url !== 'string' || message.url.length > 4096) return;
    let url;
    try { url = new URL(message.url); } catch { send(ws, { type: 'error', message: 'آدرس فیلم معتبر نیست.' }); return; }
    if (!['https:', 'http:'].includes(url.protocol)) { send(ws, { type: 'error', message: 'لینک باید با HTTP یا HTTPS باشد.' }); return; }
    let name = url.pathname.split('/').filter(Boolean).pop() || 'فیلم انتخابی';
    try { name = decodeURIComponent(name); } catch { /* Keep a malformed escape sequence as a literal filename. */ }
    playRoom.film = { url: url.href, title: name.slice(0, 150), updatedBy: 'triborg', updatedAt: Date.now() };
    playRoom.playing = false;
    playRoom.position = 0;
    playRoom.subtitle = null;
    broadcastState();
    return;
  }
  if (message.type === 'signal') {
    if (!validSignal(message)) { send(ws, { type: 'error', message: 'سیگنال تماس نامعتبر است.' }); return; }
    if (message.signalType === 'hangup') {
      playRoom.voiceOffer = null;
      broadcastState();
    } else if (ws.username === 'triborg' && message.signalType === 'offer') {
      playRoom.voiceOffer = message.description;
      broadcastState();
    } else if (ws.username === 'kimiblue' && message.signalType === 'answer') {
      playRoom.voiceOffer = null;
      broadcastState();
    }
    const target = clients.get(ws.username === 'triborg' ? 'kimiblue' : 'triborg');
    if (target) send(target, { type: 'signal', signalType: message.signalType, description: message.description, candidate: message.candidate });
    return;
  }
  send(ws, { type: 'error', message: 'نوع پیام پشتیبانی نمی‌شود.' });
}
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const origin = req.headers.origin;
  let originHost;
  try { originHost = origin ? new URL(origin).host : null; } catch { originHost = null; }
  const session = sessionFromRequest(req);
  if (pathname !== '/ws' || !originHost || originHost !== req.headers.host || !session) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  if (wss.clients.size >= MAX_CONNECTIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.username = session.username;
    ws.sessionToken = session.token;
    ws.sessionExpiresAt = session.expiresAt;
    wss.emit('connection', ws, req);
  });
});
wss.on('connection', (ws) => {
  if (clients.has(ws.username)) {
    send(ws, { type: 'error', message: 'این کاربر از دستگاه دیگری به اتاق وصل است.' });
    ws.close(1008, 'User already connected');
    return;
  }
  clients.set(ws.username, ws);
  send(ws, { type: 'auth-ok', username: ws.username, state: getPublicState(), iceServers: getIceServers(ws.username) });
  broadcastState();
  ws.on('message', (raw) => handleMessage(ws, raw));
  ws.on('close', () => {
    if (ws.username && clients.get(ws.username) === ws) {
      clients.delete(ws.username);
      playRoom.voiceOffer = null;
      broadcastState();
    }
  });
  ws.on('error', (error) => console.warn('WebSocket error:', error.message));
});
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [address, record] of authFailures) if (now > record.until) authFailures.delete(address);
  for (const [token, expiresAt] of revokedSessions) if (now >= expiresAt) revokedSessions.delete(token);
  for (const ws of wss.clients) {
    if (ws.sessionExpiresAt && now >= ws.sessionExpiresAt) { ws.close(1008, 'Session expired'); continue; }
    if (ws.isAlive === false) ws.terminate();
    else { ws.isAlive = false; ws.ping(); }
  }
}, 30000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
function shutdown() {
  clearInterval(sweep);
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(PORT, HOST, () => console.log(`Kadar server listening on http://${HOST}:${PORT}`));
