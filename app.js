const allowedUsers = ['triborg', 'kimiblue'];
const loginDialog = document.querySelector('#login-dialog');
const filmDialog = document.querySelector('#film-dialog');
const toastEl = document.querySelector('#toast');
const video = document.querySelector('#video-player');
const remoteAudio = document.querySelector('#remote-audio');
let currentUser = null, ws = null, wsIntentionalClose = false, authenticated = false;
let roomState = {}, peerConnection = null, localStream = null, activeCall = false;
let selectedUsername = '', subtitleVersion = '';
let toastTimeout, syncingVideo = false, playbackNeedsGesture = false, reconnectTimeout, mediaController, pendingIceCandidates = [];
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const $ = (selector) => document.querySelector(selector);
const isAdmin = () => currentUser?.username === 'triborg';
function showToast(message, duration = 3200) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove('show'), duration);
}
function setUser(username) {
  currentUser = { username };
  $('#avatar-letter').textContent = username === 'triborg' ? 'T' : 'K';
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  $('#guest-hint').classList.toggle('hidden', isAdmin());
  $('#header-logout').classList.remove('hidden');
  $('#triborg-audio-status').textContent = username === 'triborg' ? 'شما، مدیر اتاق' : 'منتظر اتصال';
  $('#kimi-audio-status').textContent = username === 'kimiblue' ? 'شما' : 'منتظر اتصال';
}
function openUserDialog() { if (!loginDialog.open) loginDialog.showModal(); }
function addFirebaseStyle() {
  if (document.querySelector('#user-style')) return;
  const style = document.createElement('style');
  style.id = 'user-style';
  style.textContent = '.player-shell.has-film video{display:block}.player-shell.has-film .player-empty{display:none}';
  document.head.append(style);
}
function titleFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'فیلم انتخابی'); }
  catch { return 'فیلم انتخابی'; }
}
function clientIsOnline(username) { return roomState?.users?.includes(username) ?? false; }
async function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 8000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
    });
  });
}
function setSyncStatus(connected, message) {
  $('#sync-status').innerHTML = `<span style="background:${connected ? '#76d6aa' : '#d5af6c'}"></span> ${message}`;
}
function sendMessage(message) {
  if (ws?.readyState !== WebSocket.OPEN || !authenticated) {
    showToast('اتصال اتاق برقرار نیست؛ دوباره وارد شو.');
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}
function disconnectRoom() {
  clearTimeout(reconnectTimeout);
  wsIntentionalClose = true;
  authenticated = false;
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'Switch user');
  ws = null;
  iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  roomState = {};
}
function connectToServer(username) {
  wsIntentionalClose = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setSyncStatus(false, 'درحال اتصال...');
  fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then((response) => {
    if (response.status === 401) { openUserDialog(); return; }
    if (!response.ok) throw new Error('Session check failed.');
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    bindSocket(ws);
  }).catch((error) => { console.error('Room connection failed:', error); setSyncStatus(false, 'اتصال برقرار نیست'); showToast('اتصال به سرور برقرار نشد.'); });
}
function bindSocket(socket) {
  const thisSocket = socket;
  thisSocket.addEventListener('open', () => setSyncStatus(false, 'درحال ورود به اتاق...'));
  thisSocket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'auth-ok') {
      authenticated = true;
      if (Array.isArray(message.iceServers) && message.iceServers.length) iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, ...message.iceServers];
      roomState = message.state || {};
      renderRoom(roomState);
      setSyncStatus(true, 'همگام‌سازی فعاله');
      if (!loginDialog.open) loginDialog.close();
      return;
    }
    if (message.type === 'state') {
      renderRoom(message.state || {});
      if (isAdmin() && clientIsOnline('kimiblue') && activeCall && !peerConnection?.remoteDescription && roomState.voiceOffer) {
        sendMessage({ type: 'signal', signalType: 'offer', description: roomState.voiceOffer });
        $('#voice-status').innerHTML = '<span class="pulse-dot"></span> منتظر kimiblue';
      }
      return;
    }
    if (message.type === 'signal') {
      if (message.signalType === 'hangup') { disconnectVoice(false); return; }
      handleSignal(message).catch((error) => { console.error('WebRTC signaling error:', error); showToast('اتصال صوتی برقرار نشد؛ دوباره تماس بگیر.'); });
      return;
    }
    if (message.type === 'error') showToast(message.message || 'اتصال با مشکل روبه‌رو شد.');
  });
  thisSocket.addEventListener('close', (event) => {
    if (ws !== thisSocket) return;
    authenticated = false;
    if (event.code === 1008) {
      wsIntentionalClose = true;
      fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => {
        disconnectVoice(false);
        currentUser = null;
        $('#header-logout').classList.add('hidden');
        $('#login-password').value = '';
        setSyncStatus(false, 'ورود دوباره لازم است');
        openUserDialog();
      });
    } else if (!wsIntentionalClose && currentUser) {
      setSyncStatus(false, 'اتصال قطع شد');
      reconnectTimeout = setTimeout(() => { if (currentUser && !wsIntentionalClose) connectToServer(currentUser.username); }, 2500);
    }
  });
  thisSocket.addEventListener('error', () => setSyncStatus(false, 'اتصال برقرار نیست'));
}
async function login(username, { password, existingSession = false } = {}) {
  if (!allowedUsers.includes(username)) return;
  disconnectRoom();
  const submitButton = $('#login-form button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'درحال ورود...';
  try {
    if (!existingSession) {
      const response = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json();
      if (!response.ok) {
        $('#login-error').textContent = result.error || 'نام کاربری یا رمز اشتباه است.';
        $('#login-password').value = '';
        $('#login-password').focus();
        return;
      }
    }
    $('#login-password').value = '';
    currentUser = { username };
    setUser(username);
    addFirebaseStyle();
    connectToServer(username);
  } catch (error) {
    console.error('Session login failed:', error);
    $('#login-error').textContent = 'اتصال به سرور برقرار نشد؛ اینترنت را بررسی کن.';
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'ورود به اتاق <span>←</span>';
  }
}
function updateMovieDetails(film) {
  if (!film?.url) {
    $('#movie-title').textContent = 'هنوز فیلمی انتخاب نشده';
    $('#movie-subtitle').textContent = isAdmin() ? 'اولین انتخاب با شماست.' : 'اولین انتخاب با مدیر اتاقه.';
    return;
  }
  $('#movie-title').textContent = film.title || titleFromUrl(film.url);
  $('#movie-subtitle').textContent = isAdmin() ? 'فیلم انتخابی شما • برای هردوتون' : 'فیلم رو مدیر اتاق انتخاب کرده.';
}
function publishPlayback() {
  if (isAdmin()) sendMessage({ type: 'playback', playing: !video.paused, position: video.currentTime });
}
function renderRoom(state) {
  roomState = state || {};
  if (roomState.voiceOffer && !isAdmin() && activeCall && peerConnection && peerConnection.remoteDescription?.sdp !== roomState.voiceOffer.sdp) {
    handleSignal({ type: 'signal', signalType: 'offer', description: roomState.voiceOffer }).catch((error) => console.error('Could not accept pending call:', error));
  }
  const film = roomState.film;
  video.controls = isAdmin();
  updateSubtitleTrack(roomState.subtitle);
  if (film?.url && video.dataset.url !== film.url) {
    mediaController?.destroy?.();
    mediaController = null;
    video.dataset.url = film.url;
    $('#player-loading').classList.remove('hidden');
    if (/\.m3u8(?:$|[?#])/i.test(film.url) && !video.canPlayType('application/vnd.apple.mpegurl')) {
      import('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/+esm').then(({ default: Hls }) => {
        if (video.dataset.url !== film.url) return;
        if (Hls.isSupported()) { mediaController = new Hls(); mediaController.loadSource(film.url); mediaController.attachMedia(video); }
        else { $('#player-loading').classList.add('hidden'); showToast('این مرورگر از پخش HLS پشتیبانی نمی‌کند.'); }
      }).catch(() => { $('#player-loading').classList.add('hidden'); showToast('HLS در دسترس نیست؛ لینک MP4 امتحان کن.'); });
    } else { video.src = film.url; video.load(); }
    updateMovieDetails(film);
  } else if (!film?.url && !video.dataset.url) updateMovieDetails(null);
  const position = Number(roomState.position || 0);
  const updatedAt = Number(roomState.positionUpdatedAt || Date.now());
  const expectedPosition = position + (roomState.playing ? Math.max(0, Date.now() - updatedAt) / 1000 : 0);
  if (video.dataset.url && video.readyState >= 1 && Math.abs(video.currentTime - expectedPosition) > 2.5 && Number.isFinite(expectedPosition)) {
    syncingVideo = true;
    video.currentTime = expectedPosition;
  }
  if (video.dataset.url && roomState.playing && video.paused && !playbackNeedsGesture) {
    video.play().catch(() => {
      if (!isAdmin() && !playbackNeedsGesture) { playbackNeedsGesture = true; showToast('برای شروع تماشای همگام، یک بار روی فیلم بزن.'); }
    });
  }
  if (roomState.playing === false && !video.paused) video.pause();
  if (film?.url) $('#player-shell').classList.add('has-film');
}
function updateSubtitleTrack(subtitle) {
  const track = $('#subtitle-track');
  const removeButton = $('#remove-subtitle');
  removeButton?.classList.toggle('hidden', !isAdmin() || !subtitle);
  if (!subtitle?.updatedAt) {
    if (subtitleVersion) { track.removeAttribute('src'); track.track.mode = 'disabled'; subtitleVersion = ''; }
    return;
  }
  const version = String(subtitle.updatedAt);
  if (subtitleVersion === version) return;
  subtitleVersion = version;
  track.label = subtitle.name || 'فارسی';
  track.src = `/api/subtitle?v=${encodeURIComponent(version)}`;
  track.track.mode = 'showing';
  track.onerror = () => showToast('زیرنویس دریافت نشد؛ دوباره وارد اتاق شو.');
}
function convertSrtToVtt(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error('فایل زیرنویس خالی است.');
  const escapeCueText = (value) => value.replace(/</g, '&lt;');
  const cues = normalized.split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n');
    const timestampIndex = lines.findIndex((line) => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line));
    if (timestampIndex < 0) return '';
    const timing = lines[timestampIndex].replace(/(\d{2}:\d{2}:\d{2}),([0-9]{3})/g, '$1.$2');
    const cueText = lines.slice(timestampIndex + 1).map(escapeCueText).join('\n').trim();
    return cueText ? `${timing}\n${cueText}` : '';
  }).filter(Boolean);
  if (!cues.length) throw new Error('ساختار فایل SRT معتبر نیست.');
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
async function publishSubtitle(file) {
  if (!isAdmin()) throw new Error('فقط triborg می‌تونه زیرنویس انتخاب کنه.');
  if (!file || !/\.srt$/i.test(file.name)) throw new Error('لطفاً یک فایل با پسوند SRT انتخاب کن.');
  if (file.size > 160 * 1024) throw new Error('حجم زیرنویس باید کمتر از ۱۶۰ کیلوبایت باشد.');
  const vtt = convertSrtToVtt(await file.text());
  if (new TextEncoder().encode(vtt).byteLength > 220 * 1024) throw new Error('حجم زیرنویس تبدیل‌شده بیش از حد مجاز است.');
  if (!sendMessage({ type: 'subtitle', name: file.name.replace(/\.srt$/i, '').slice(0, 120) || 'زیرنویس فارسی', vtt })) throw new Error('اتصال به اتاق برقرار نیست.');
  showToast('زیرنویس برای هر دو نفر اضافه شد.');
}
function requestFilm() {
  if (!isAdmin()) { showToast('فقط triborg می‌تونه فیلم انتخاب کنه.'); return; }
  $('#film-url').value = '';
  if (!filmDialog.open) filmDialog.showModal();
}
function publishFilm(url) {
  if (!isAdmin()) throw new Error('فقط triborg می‌تونه فیلم انتخاب کنه.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('آدرس لینک فیلم معتبر نیست.'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('لینک باید با HTTP یا HTTPS باشد.');
  if (!sendMessage({ type: 'publish', url: parsed.href })) throw new Error('اتصال به اتاق برقرار نیست.');
}
async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('میکروفون به اتصال امن HTTPS نیاز دارد.');
  localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  peerConnection = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  pendingIceCandidates = [];
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) sendMessage({ type: 'signal', signalType: 'candidate', candidate: event.candidate.toJSON() });
  };
  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0]; remoteAudio.play().catch(() => {});
    $('#voice-status').innerHTML = '<span class="pulse-dot"></span> وصلی';
    document.querySelectorAll('.voice-person').forEach((el) => el.classList.add('speaking'));
    $('#mic-toggle').disabled = false;
  };
  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'connected') $('#voice-status').innerHTML = '<span class="pulse-dot"></span> وصلی';
    else if (['failed', 'closed', 'disconnected'].includes(peerConnection.connectionState)) {
      $('#voice-status').innerHTML = '<span></span> قطع شده';
      if (peerConnection.connectionState === 'failed') showToast('تماس ناموفق بود؛ شبکه را بررسی کن.');
    }
  };
  return peerConnection;
}
async function handleSignal(message) {
  const pc = peerConnection;
  if (!pc) return;
  if (message.signalType === 'offer' && !isAdmin() && message.description) {
    if (pc.remoteDescription?.sdp === message.description.sdp || pc.signalingState !== 'stable') return;
    await pc.setRemoteDescription(message.description);
    for (const candidate of pendingIceCandidates.splice(0)) await pc.addIceCandidate(candidate);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    sendMessage({ type: 'signal', signalType: 'answer', description: pc.localDescription.toJSON() });
  } else if (message.signalType === 'answer' && isAdmin() && pc.signalingState === 'have-local-offer' && message.description) {
    await pc.setRemoteDescription(message.description);
    for (const candidate of pendingIceCandidates.splice(0)) await pc.addIceCandidate(candidate);
  } else if (message.signalType === 'candidate' && message.candidate) {
    if (!pc.remoteDescription) pendingIceCandidates.push(message.candidate);
    else { try { await pc.addIceCandidate(message.candidate); } catch (error) { console.warn('ICE candidate was ignored:', error.message); } }
  }
}
async function connectVoice() {
  if (!authenticated) { showToast('اول به اتاق وصل شو.'); return; }
  if (activeCall) { disconnectVoice(); return; }
  const button = $('#connect-voice'); button.disabled = true;
  try {
    const pc = await ensurePeerConnection();
    activeCall = true;
    if (isAdmin()) {
      $('#voice-status').innerHTML = '<span class="pulse-dot"></span> منتظر kimiblue';
      if (clientIsOnline('kimiblue')) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        sendMessage({ type: 'signal', signalType: 'offer', description: pc.localDescription.toJSON() });
      } else showToast('اتصال آماده‌ست؛ به‌محض ورود kimiblue تماس برقرار می‌شه.');
    } else if (roomState.voiceOffer) {
      await handleSignal({ type: 'signal', signalType: 'offer', description: roomState.voiceOffer });
    } else {
      $('#voice-status').innerHTML = '<span class="pulse-dot"></span> منتظر مدیر';
      showToast('میکروفون آماده‌ست؛ همین که مدیر وصل بشه تماس برقرار می‌شه.');
    }
    $('#mic-toggle').disabled = false;
    $('#mic-toggle').classList.add('active');
    $('#mic-title').textContent = 'میکروفون وصله';
    $('#mic-description').textContent = 'برای قطع صدات روی میکروفون بزن.';
    $('.mic-on').classList.remove('hidden'); $('.mic-off').classList.add('hidden');
    button.querySelector('span').textContent = 'قطع'; button.dataset.connected = 'true';
  } catch (error) {
    console.error('Could not connect voice:', error);
    disconnectVoice();
    showToast(error.name === 'NotAllowedError' ? 'برای تماس باید اجازهٔ استفاده از میکروفون رو بدی.' : error.message || 'اتصال میکروفون ناموفق بود.');
  } finally { button.disabled = false; }
}
function disconnectVoice(showNotice = true) {
  if (activeCall && authenticated) sendMessage({ type: 'signal', signalType: 'hangup' });
  activeCall = false;
  localStream?.getTracks().forEach((track) => track.stop()); localStream = null;
  peerConnection?.close(); peerConnection = null; remoteAudio.srcObject = null; pendingIceCandidates = [];
  document.querySelectorAll('.voice-person').forEach((el) => el.classList.remove('speaking'));
  $('#mic-toggle').disabled = true; $('#mic-toggle').classList.remove('active');
  $('.mic-on').classList.remove('hidden'); $('.mic-off').classList.add('hidden');
  $('#voice-status').innerHTML = '<span class="pulse-dot"></span> آماده';
  $('#mic-title').textContent = 'برای شروع صدات رو وصل کن';
  $('#mic-description').textContent = 'فقط برای این اتاق؛ هر وقت بخوای قطع می‌شه.';
  $('#connect-voice').querySelector('span').textContent = 'اتصال'; $('#connect-voice').dataset.connected = '';
  if (showNotice) showToast('تماس صوتی قطع شد.');
}

$('#profile-button').addEventListener('click', openUserDialog);
document.querySelectorAll('.user-choice').forEach((button) => button.addEventListener('click', () => {
  selectedUsername = button.dataset.user;
  document.querySelectorAll('.user-choice').forEach((choice) => choice.classList.toggle('selected', choice === button));
  $('#login-password-label').textContent = `رمز ${selectedUsername}`;
  $('#login-password').value = '';
  $('#login-error').textContent = '';
  $('.login-panel').classList.remove('hidden');
  $('#login-password').focus();
}));
$('#add-film').addEventListener('click', requestFilm);
$('#change-film').addEventListener('click', requestFilm);
$('#add-first-film').addEventListener('click', requestFilm);
$('#subtitle-file').addEventListener('change', async (event) => {
  try { await publishSubtitle(event.target.files[0]); }
  catch (error) { showToast(error.message || 'افزودن زیرنویس انجام نشد.'); }
  finally { event.target.value = ''; }
});
$('#remove-subtitle').addEventListener('click', () => {
  if (isAdmin() && sendMessage({ type: 'clear-subtitle' })) showToast('زیرنویس حذف شد.');
});
$('#film-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try { publishFilm($('#film-url').value.trim()); filmDialog.close(); showToast('درخواست پخش فیلم به اتاق ارسال شد.'); }
  catch (error) { showToast(error.message || 'ذخیرهٔ فیلم انجام نشد.'); }
});
$('#copy-room').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href.split('#')[0]); showToast('لینک اتاق کپی شد؛ برای نفر دوم بفرستش.'); }
  catch { showToast('لینک اتاق: ' + location.href.split('#')[0], 6000); }
});
$('#connect-voice').addEventListener('click', connectVoice);
$('#mic-toggle').addEventListener('click', () => {
  const enabled = $('#mic-toggle').classList.toggle('active');
  localStream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  $('.mic-on').classList.toggle('hidden', !enabled); $('.mic-off').classList.toggle('hidden', enabled);
  $('#mic-title').textContent = enabled ? 'میکروفون وصله' : 'میکروفون خاموشه';
});
video.addEventListener('loadedmetadata', () => $('#player-loading').classList.add('hidden'));
video.addEventListener('error', () => { $('#player-loading').classList.add('hidden'); showToast('فیلم پخش نشد؛ لینک باید مستقیم و قابل‌دسترسی باشد.'); });
video.addEventListener('playing', () => { video.parentElement.classList.add('is-playing'); $('#player-loading').classList.add('hidden'); });
video.addEventListener('pause', () => video.parentElement.classList.remove('is-playing'));
video.addEventListener('play', () => {
  playbackNeedsGesture = false; video.parentElement.classList.add('is-playing');
  if (!syncingVideo && isAdmin()) publishPlayback();
});
video.addEventListener('click', () => {
  if (!isAdmin() && playbackNeedsGesture && roomState?.playing && video.paused) {
    playbackNeedsGesture = false;
    video.play().catch(() => { playbackNeedsGesture = true; showToast('برای پخش فیلم، دوباره روی آن بزن.'); });
  }
});
video.addEventListener('pause', () => { if (!syncingVideo && isAdmin()) publishPlayback(); });
video.addEventListener('seeked', () => { syncingVideo = false; if (isAdmin()) sendMessage({ type: 'playback', playing: !video.paused, position: video.currentTime }); });
let lastPlaybackSyncAt = 0;
video.addEventListener('timeupdate', () => {
  if (!isAdmin() || video.paused) return;
  const now = Date.now();
  if (now - lastPlaybackSyncAt < 1800) return;
  lastPlaybackSyncAt = now;
  sendMessage({ type: 'playback', playing: true, position: video.currentTime });
});
window.addEventListener('pagehide', () => {
  clearTimeout(reconnectTimeout); wsIntentionalClose = true; disconnectVoice(false);
  if (ws?.readyState === WebSocket.OPEN) ws.close(1000, 'Page closed');
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Offline cache unavailable:', error)));
}
$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedUsername) { $('#login-error').textContent = 'اول یکی از کاربران را انتخاب کن.'; return; }
  login(selectedUsername, { password: $('#login-password').value });
});
$('#login-password').addEventListener('input', () => $('#login-error').textContent = '');
$('#profile-button').addEventListener('click', () => {
  if (currentUser) { showToast(`وارد حساب ${currentUser.username} هستی. برای عوض کردن کاربر اول خارج شو.`); return; }
  openUserDialog();
});
$('#header-logout').addEventListener('click', async () => {
  $('#header-logout').disabled = true;
  disconnectVoice(false); disconnectRoom();
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  currentUser = null; selectedUsername = '';
  $('#header-logout').disabled = false;
  $('#header-logout').classList.add('hidden');
  $('#login-password').value = ''; $('#login-error').textContent = '';
  $('.login-panel').classList.add('hidden');
  openUserDialog();
});
async function checkExistingSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) { openUserDialog(); return; }
    const session = await response.json();
    if (allowedUsers.includes(session.username)) await login(session.username, { existingSession: true });
    else openUserDialog();
  } catch { openUserDialog(); }
}
setTimeout(checkExistingSession, 200);
