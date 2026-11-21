import { DurableObject } from 'cloudflare:workers';

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_BYTES = 4096;
const MAX_MESSAGE_BYTES = 300 * 1024;
const MAX_CAPTION_BYTES = 256 * 1024;
const USERNAMES = new Set(['triborg', 'kimiblue']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}
function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return mismatch === 0;
}
function validPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60 * 60 * 24 * 30;
}
function validSignal(message) {
  if (message.signalType === 'hangup') return true;
  if (message.signalType === 'offer' || message.signalType === 'answer') {
    const desc = message.description;
    return desc && desc.type === message.signalType && typeof desc.sdp === 'string' && desc.sdp.length > 0 && desc.sdp.length <= 16000;
  }
  if (message.signalType === 'candidate') {
    const candidate = message.candidate;
    return candidate === null || (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 2048 && (candidate.sdpMid == null || typeof candidate.sdpMid === 'string'));
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/healthz') {
      if (!env.WATCH_ROOM) return new Response('Missing WATCH_ROOM Durable Object binding. Deploy with the project Wrangler configuration.', { status: 503 });
      const room = env.WATCH_ROOM.getByName('private-watch-room');
      return room.fetch(request);
    }
    if (!env.ASSETS) return new Response('Missing ASSETS binding. Deploy with `npm run deploy` from the cloudflare directory.', { status: 503 });
    return env.ASSETS.fetch(request);
  },
};

export class WatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.roomPromise = ctx.storage.get('room').then((saved) => saved || {
      film: null,
      playing: false,
      position: 0,
      positionUpdatedAt: Date.now(),
      subtitle: null,
      voiceOffer: null,
    });
    this.hmacKeyPromise = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.connectWebSocket(request);
    if (url.pathname === '/api/login' && request.method === 'POST') return this.login(request);
    if (url.pathname === '/api/session' && request.method === 'GET') return this.checkSession(request);
    if (url.pathname === '/api/logout' && request.method === 'POST') return this.logout(request);
    if (url.pathname === '/api/subtitle' && request.method === 'GET') return this.getSubtitle(request);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return jsonResponse(200, { ok: true, users: this.ctx.getWebSockets().length });
    }
    if (url.pathname.startsWith('/api/')) return jsonResponse(404, { error: 'مسیر پیدا نشد.' });
    return new Response('Not found', { status: 404 });
  }

  async sessionKey() {
    if (!this.env.KADAR_SESSION_SECRET || encoder.encode(this.env.KADAR_SESSION_SECRET).length < 32) {
      throw new Error('KADAR_SESSION_SECRET must contain at least 32 characters.');
    }
    this.hmacKeyPromise ||= crypto.subtle.importKey(
      'raw', encoder.encode(this.env.KADAR_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    return this.hmacKeyPromise;
  }

  async signSession(payload) {
    const data = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
    const signature = await crypto.subtle.sign('HMAC', await this.sessionKey(), encoder.encode(data));
    return `${data}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  async readSession(token) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const data = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    if (!data || !signature) return null;
    try {
      const valid = await crypto.subtle.verify('HMAC', await this.sessionKey(), signature, encoder.encode(parts[0]));
      if (!valid) return null;
      const payload = JSON.parse(decoder.decode(data));
      if (!USERNAMES.has(payload.username) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
      if (await this.ctx.storage.get(`revoked:${token}`)) return null;
      return { token, ...payload };
    } catch { return null; }
  }

  async sessionFromRequest(request) {
    const token = parseCookies(request.headers.get('cookie') || '')['__Host-kadar_session'];
    return this.readSession(token);
  }

  originMatches(request) {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
  }

  cookie(token, clear = false) {
    return `__Host-kadar_session=${clear ? '' : token}; Path=/; Max-Age=${clear ? 0 : SESSION_TTL / 1000}; HttpOnly; SameSite=Strict; Secure`;
  }

  async login(request) {
    if (!this.originMatches(request)) return jsonResponse(403, { error: 'درخواست ورود معتبر نیست.' });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return jsonResponse(415, { error: 'درخواست ورود معتبر نیست.' });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_LOGIN_BYTES) return jsonResponse(400, { error: 'اطلاعات ورود معتبر نیست.' });
    let payload;
    try { payload = JSON.parse(decoder.decode(bytes)); } catch { return jsonResponse(400, { error: 'اطلاعات ورود معتبر نیست.' }); }
    const { username, password } = payload || {};
    if (!USERNAMES.has(username) || typeof password !== 'string' || password.length > 256) {
      return jsonResponse(401, { error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `auth-failure:${address}`;
    const now = Date.now();
    const previous = await this.ctx.storage.get(key);
    if (previous && now < previous.until && previous.count >= 6) {
      return jsonResponse(429, { error: 'ورودهای ناموفق زیاد بود؛ ۱۵ دقیقهٔ دیگر تلاش کنیم.' });
    }
    const expected = username === 'triborg' ? this.env.TRIBORG_PASSWORD : this.env.KIMIBLUE_PASSWORD;
    if (!expected || expected.length < 12) return jsonResponse(503, { error: 'حساب کاربری روی سرور تنظیم نشده است.' });
    if (!constantTimeEqual(password, expected)) {
      const record = previous && now < previous.until ? previous : { count: 0, until: now + 15 * 60 * 1000 };
      record.count += 1;
      await this.ctx.storage.put(key, record);
      await this.scheduleCleanup(record.until);
      return jsonResponse(record.count >= 6 ? 429 : 401, { error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    await this.ctx.storage.delete(key);
    const expiresAt = now + SESSION_TTL;
    const token = await this.signSession({ username, expiresAt, nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))) });
    return jsonResponse(200, { username, expiresAt }, { 'set-cookie': this.cookie(token) });
  }

  async checkSession(request) {
    const session = await this.sessionFromRequest(request);
    return session
      ? jsonResponse(200, { username: session.username, expiresAt: session.expiresAt })
      : jsonResponse(401, { error: 'ورود لازم است.' });
  }

  async logout(request) {
    if (!this.originMatches(request)) return jsonResponse(403, { error: 'درخواست خروج معتبر نیست.' });
    const session = await this.sessionFromRequest(request);
    if (session) {
      await this.ctx.storage.put(`revoked:${session.token}`, session.expiresAt);
      await this.scheduleCleanup(session.expiresAt);
      for (const socket of this.activeSockets()) {
        const attachment = socket.deserializeAttachment();
        if (attachment?.token === session.token) socket.close(1000, 'Logged out');
      }
    }
    return jsonResponse(200, { ok: true }, { 'set-cookie': this.cookie('', true) });
  }

  async scheduleCleanup(at) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null || at < existing) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const now = Date.now();
    let nextAlarm = null;
    for (const socket of this.activeSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.expiresAt <= now) socket.close(1008, 'Session expired');
      else if (attachment?.expiresAt) nextAlarm = nextAlarm == null ? attachment.expiresAt : Math.min(nextAlarm, attachment.expiresAt);
    }
    for (const [key, value] of await this.ctx.storage.list({ prefix: 'revoked:' })) {
      if (value <= now) await this.ctx.storage.delete(key);
      else nextAlarm = nextAlarm == null ? value : Math.min(nextAlarm, value);
    }
    for (const [key, value] of await this.ctx.storage.list({ prefix: 'auth-failure:' })) {
      if (value.until <= now) await this.ctx.storage.delete(key);
      else nextAlarm = nextAlarm == null ? value.until : Math.min(nextAlarm, value.until);
    }
    if (nextAlarm != null) await this.ctx.storage.setAlarm(nextAlarm);
  }

  async getSubtitle(request) {
    if (!await this.sessionFromRequest(request)) return jsonResponse(401, { error: 'ورود لازم است.' });
    const room = await this.roomPromise;
    if (!room.subtitle) return jsonResponse(404, { error: 'زیرنویسی انتخاب نشده است.' });
    return new Response(room.subtitle.vtt, {
      headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  async connectWebSocket(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    if (!this.originMatches(request)) return new Response('Forbidden', { status: 403 });
    const session = await this.sessionFromRequest(request);
    if (!session) return new Response('Unauthorized', { status: 401 });
    const sockets = this.activeSockets();
    const duplicate = sockets.find((socket) => socket.deserializeAttachment()?.username === session.username);
    if (sockets.length >= 2 && !duplicate) return new Response('Room is full.', { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ username: session.username, token: session.token, expiresAt: session.expiresAt });
    await this.scheduleCleanup(session.expiresAt);
    if (duplicate) {
      this.send(server, { type: 'error', message: 'این کاربر از دستگاه دیگری به اتاق وصل است.' });
      server.close(1008, 'User already connected');
      return new Response(null, { status: 101, webSocket: client });
    }
    const room = await this.roomPromise;
    this.send(server, { type: 'auth-ok', username: session.username, state: this.publicState(room), iceServers: await this.getIceServers(session.username) });
    await this.broadcastState(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  async getIceServers(username) {
    const urls = (this.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
    if (!urls.length || !this.env.TURN_SECRET) return [];
    const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const turnUsername = `${expiry}:${username}`;
    const key = await crypto.subtle.importKey('raw', encoder.encode(this.env.TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const credential = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(turnUsername)))));
    return [{ urls, username: turnUsername, credential }];
  }

  activeSockets() {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === 1);
  }

  publicState(room) {
    const users = [...new Set(this.activeSockets().map((socket) => socket.deserializeAttachment()?.username).filter(Boolean))];
    return { ...room, subtitle: room.subtitle ? { name: room.subtitle.name, updatedAt: room.subtitle.updatedAt } : null, users };
  }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)); } catch { /* The client may have disconnected between events. */ }
  }

  async broadcastState(room) {
    room ||= await this.roomPromise;
    const message = JSON.stringify({ type: 'state', state: this.publicState(room) });
    for (const socket of this.activeSockets()) {
      try { socket.send(message); } catch { /* Ignore a socket that closed during broadcast. */ }
    }
  }

  async saveRoom(room, { persist = true } = {}) {
    this.roomPromise = Promise.resolve(room);
    if (persist) {
      room.positionPersistedAt = Date.now();
      await this.ctx.storage.put('room', room);
    }
    await this.broadcastState(room);
  }

  async webSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment();
    if (!attachment || attachment.expiresAt <= Date.now() || !await this.readSession(attachment.token)) {
      socket.close(1008, 'Session expired');
      return;
    }
    if (typeof raw !== 'string' || encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'Message too large');
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { this.send(socket, { type: 'error', message: 'پیام نامعتبر است.' }); return; }
    const username = attachment.username;
    const room = await this.roomPromise;
    if (message.type === 'playback') {
      if (username !== 'triborg') { this.send(socket, { type: 'error', message: 'فقط مدیر اتاق می‌تواند پخش را کنترل کند.' }); return; }
      if (typeof message.playing !== 'boolean' || !validPosition(message.position)) return;
      room.playing = message.playing;
      room.position = message.position;
      room.positionUpdatedAt = Date.now();
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'position-sync') {
      const adminOnline = this.activeSockets().some((client) => client.deserializeAttachment()?.username === 'triborg');
      if (username !== 'kimiblue' || adminOnline || !room.film || !validPosition(message.position)) return;
      room.position = message.position;
      room.positionUpdatedAt = Date.now();
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'subtitle') {
      if (username !== 'triborg') { this.send(socket, { type: 'error', message: 'فقط مدیر اتاق می‌تواند زیرنویس انتخاب کند.' }); return; }
      if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 120 || typeof message.vtt !== 'string' || !message.vtt.startsWith('WEBVTT\n') || encoder.encode(message.vtt).byteLength > MAX_CAPTION_BYTES) {
        this.send(socket, { type: 'error', message: 'فایل زیرنویس معتبر نیست یا حجم آن بیش از حد مجاز است.' }); return;
      }
      room.subtitle = { name: message.name.trim(), vtt: message.vtt, updatedAt: Date.now() };
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'clear-subtitle') {
      if (username !== 'triborg') { this.send(socket, { type: 'error', message: 'فقط مدیر اتاق می‌تواند زیرنویس را حذف کند.' }); return; }
      room.subtitle = null;
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'remove-film') {
      if (username !== 'triborg') { this.send(socket, { type: 'error', message: 'فقط مدیر اتاق می‌تواند فیلم را حذف کند.' }); return; }
      room.film = null;
      room.playing = false;
      room.position = 0;
      room.positionUpdatedAt = Date.now();
      room.subtitle = null;
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'publish') {
      if (username !== 'triborg') { this.send(socket, { type: 'error', message: 'فقط مدیر اتاق می‌تواند فیلم انتخاب کند.' }); return; }
      if (typeof message.url !== 'string' || message.url.length > 4096) return;
      let url;
      try { url = new URL(message.url); } catch { this.send(socket, { type: 'error', message: 'آدرس فیلم معتبر نیست.' }); return; }
      if (!['https:', 'http:'].includes(url.protocol)) { this.send(socket, { type: 'error', message: 'لینک باید با HTTP یا HTTPS باشد.' }); return; }
      let title = url.pathname.split('/').filter(Boolean).pop() || 'فیلم انتخابی';
      try { title = decodeURIComponent(title); } catch { /* Preserve malformed escapes as a literal title. */ }
      room.film = { url: url.href, title: title.slice(0, 150), updatedBy: 'triborg', updatedAt: Date.now() };
      room.playing = false;
      room.position = 0;
      room.positionUpdatedAt = Date.now();
      room.subtitle = null;
      await this.saveRoom(room);
      return;
    }
    if (message.type === 'signal') {
      if (!validSignal(message)) { this.send(socket, { type: 'error', message: 'سیگنال تماس نامعتبر است.' }); return; }
      if (message.signalType === 'hangup') {
        room.voiceOffer = null;
        await this.saveRoom(room);
      } else if (username === 'triborg' && message.signalType === 'offer') {
        room.voiceOffer = message.description;
        await this.saveRoom(room);
      } else if (username === 'kimiblue' && message.signalType === 'answer') {
        room.voiceOffer = null;
        await this.saveRoom(room);
      }
      const target = this.activeSockets().find((client) => client !== socket && client.deserializeAttachment()?.username !== username);
      if (target) this.send(target, { type: 'signal', signalType: message.signalType, description: message.description, candidate: message.candidate });
      return;
    }
    this.send(socket, { type: 'error', message: 'نوع پیام پشتیبانی نمی‌شود.' });
  }

  async webSocketClose(socket) {
    try { socket.close(1000, 'Connection closed'); } catch { /* The close frame was already acknowledged. */ }
    const closedUser = socket.deserializeAttachment()?.username;
    if (closedUser && this.activeSockets().some((client) => client.deserializeAttachment()?.username === closedUser)) return;
    const room = await this.roomPromise;
    room.voiceOffer = null;
    if (this.activeSockets().length === 0 && room.playing) {
      room.position += Math.max(0, Date.now() - (room.positionUpdatedAt || Date.now())) / 1000;
      room.playing = false;
      room.positionUpdatedAt = Date.now();
    }
    await this.saveRoom(room);
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'WebSocket error'); } catch { /* Already closed. */ }
  }
}
