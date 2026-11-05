const $ = (id) => document.getElementById(id);
const video = $('screen');
const STORAGE_KEY = 'kopru-code';
const AUTO_KB_KEY = 'kopru-auto-keyboard';
const MAX_ZOOM = 5;
const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent);

let ws;
let code = '';
let pc;
let input;
let file;
let hostPlatform = 'darwin';
let swapMeta = false;
let trackpad = false;
let fastMode = false;
let autoKeyboard = false;
let hostError = '';
let inSession = false;
let wakeLock;
let statsTimer;
let remoteClip = '';
let pingTimer;
let view = { z: 1, x: 0, y: 0 };

const REASONS = {
  offline: 'Cihaz çevrimdışı.',
  kicked: 'Bağlantı karşı cihazdan kesildi.',
  replaced: 'Bu cihaza başka bir yerden bağlanıldı.',
};

const storage = {
  get: (key = STORAGE_KEY) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (v, key = STORAGE_KEY) => { try { localStorage.setItem(key, v); } catch { /* gizli pencere */ } },
  clear: () => { try { localStorage.removeItem(STORAGE_KEY); } catch { /* gizli pencere */ } },
};

const send = (ev) => {
  if (input?.readyState === 'open') input.send(JSON.stringify(ev));
};
const hub = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

let toastTimer;
function toast(text, keep) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  if (!keep) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function show(id) {
  for (const el of ['login', 'devices', 'session']) $(el).hidden = el !== id;
}

// Giriş ve cihaz listesi
function login() {
  $('error').textContent = '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/client`);
  ws.onopen = () => hub({ type: 'auth', code });
  ws.onmessage = onHubMessage;
  ws.onclose = () => {
    endSession('Bağlantı koptu, yeniden deneniyor.');
    if (code) setTimeout(login, 2000);
  };
  clearInterval(pingTimer);
  pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
}

async function onHubMessage(e) {
  if (e.data === 'pong') return;
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'ok':
      if ($('remember').checked) storage.set(code);
      renderDevices(msg.devices);
      show('devices');
      break;
    case 'denied':
      code = '';
      storage.clear();
      show('login');
      $('error').textContent = msg.reason === 'locked' ? 'Çok fazla deneme. 10 dakika sonra tekrar dene.' : 'Erişim kodu yanlış.';
      break;
    case 'devices':
      renderDevices(msg.devices);
      break;
    case 'connected':
      hostPlatform = msg.hostPlatform;
      swapMeta = !isMobile && /Mac/.test(navigator.platform) !== (hostPlatform === 'darwin');
      $('device-name').textContent = msg.name;
      buildKeys();
      startPeer(msg.iceServers);
      break;
    case 'signal':
      if (msg.data.error) hostError = msg.data.error;
      if (!pc) return;
      if (msg.data.description) {
        await pc.setRemoteDescription(msg.data.description);
        await pc.setLocalDescription(await pc.createAnswer());
        hub({ type: 'signal', data: { description: pc.localDescription.toJSON() } });
      }
      if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
      break;
    case 'session-ended':
      endSession(hostError || REASONS[msg.reason]);
      break;
  }
}

function deviceIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function renderDevices(devices) {
  $('empty').hidden = devices.length > 0;
  $('device-count').textContent = devices.length ? `${devices.length} cihaz çevrimiçi` : '';
  $('device-list').replaceChildren(...devices.map((d) => {
    const mac = d.platform === 'darwin';
    const row = document.createElement('button');
    row.className = 'device';
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    thumb.append(deviceIcon(mac ? 'laptop' : 'desktop'));
    const info = document.createElement('span');
    info.className = 'info';
    const name = document.createElement('strong');
    name.textContent = d.name;
    const state = document.createElement('span');
    state.className = `state${d.busy ? ' busy' : ''}`;
    state.textContent = `${mac ? 'macOS' : 'Windows'} · ${d.busy ? 'Kullanımda' : 'Çevrimiçi'}`;
    info.append(name, state);
    row.append(thumb, info, deviceIcon('chevron'));
    row.onclick = () => connectDevice(d);
    return row;
  }));
}

function connectDevice(device) {
  inSession = true;
  $('device-error').textContent = '';
  $('waiting').hidden = false;
  $('waiting-title').textContent = `${device.name} cihazına bağlanılıyor`;
  show('session');
  setTrackpad(trackpad);
  setQualityButtons(fastMode);
  navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  hub({ type: 'connect', device: device.id });
}

function endSession(message) {
  if (!inSession) return;
  inSession = false;
  hub({ type: 'disconnect' });
  pc?.close();
  pc = input = file = null;
  video.srcObject = null;
  video.muted = true;
  clearInterval(statsTimer);
  wakeLock?.release().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen();
  togglePanel(false);
  setView(1, 0, 0);
  $('device-error').textContent = message ?? '';
  hostError = '';
  remoteClip = '';
  $('clip-get').disabled = true;
  $('sound').hidden = true;
  $('toast').hidden = true;
  autoKeyboard = false;
  typing.blur();
  $('display-row').hidden = true;
  show(code ? 'devices' : 'login');
}

// WebRTC
function startPeer(iceServers) {
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => e.candidate && hub({ type: 'signal', data: { candidate: e.candidate.toJSON() } });
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'input') {
      input = e.channel;
      input.onmessage = (m) => onControl(JSON.parse(m.data));
      input.onopen = () => setQuality(fastMode);
    } else {
      file = e.channel;
      file.binaryType = 'arraybuffer';
      file.onmessage = onFileMessage;
    }
  };
  pc.ontrack = (e) => {
    e.receiver.jitterBufferTarget = 0;
    video.srcObject = e.streams[0];
    if (e.track.kind === 'audio') {
      video.muted = false;
      $('sound-label').textContent = 'Sesi kapat';
      $('sound').hidden = false;
      video.play().catch(() => { video.muted = true; $('sound-label').textContent = 'Sesi aç'; });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'failed') endSession('Cihazla bağlantı kurulamadı.');
  };
  statsTimer = setInterval(updateStats, 2000);
}

video.addEventListener('playing', () => { $('waiting').hidden = true; });

function onControl(ev) {
  switch (ev.t) {
    case 'displays':
      $('display').replaceChildren(...ev.list.map((d) => new Option(d.name, d.id, false, d.id === ev.current)));
      $('display-row').hidden = ev.list.length < 2;
      break;
    case 'clip':
      remoteClip = ev.s;
      $('clip-get').disabled = false;
      navigator.clipboard?.writeText(ev.s).catch(() => {});
      break;
    case 'focus':
      if (ev.text && $('auto-kb').checked) {
        showKeyboard();
        autoKeyboard = true;
      } else if (!ev.text && autoKeyboard) {
        hideKeyboard();
        autoKeyboard = false;
      }
      break;
    case 'saved':
      toast(`Uzak bilgisayarda İndirilenler klasörüne kaydedildi: ${ev.name}`);
      break;
  }
}

let lastBytes = 0;
async function updateStats() {
  if (!pc || $('panel').hidden) return;
  if (!video.videoWidth) return;
  const stats = await pc.getStats();
  let fps = 0;
  let bytes = 0;
  let width = 0;
  let height = 0;
  let pair;
  stats.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      fps = s.framesPerSecond ?? 0;
      bytes = s.bytesReceived;
      width = s.frameWidth;
      height = s.frameHeight;
    }
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  const relayed = pair && [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)].some((c) => c?.candidateType === 'relay');
  const rows = [
    ['Çözünürlük', width ? `${width}×${height}` : '–'],
    ['Kare hızı', `${Math.round(fps)} FPS`],
    ['Veri hızı', `${(Math.max(0, bytes - lastBytes) * 8 / 2e6).toFixed(1)} Mbps`],
    ['Gecikme', pair?.currentRoundTripTime === undefined ? '–' : `${Math.round(pair.currentRoundTripTime * 1000)} ms`],
  ];
  $('path-label').textContent = pair ? (relayed ? 'Cloudflare üzerinden aktarılıyor' : 'Doğrudan bağlı') : 'Bağlantı kuruluyor';
  lastBytes = bytes;
  $('stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

// Zoom ve kaydırma
function setView(z, x, y) {
  const w = innerWidth;
  const h = innerHeight;
  const zoom = Math.min(MAX_ZOOM, Math.max(1, z));
  view = {
    z: zoom,
    x: Math.min(0, Math.max(w - w * zoom, x)),
    y: Math.min(0, Math.max(h - h * zoom, y)),
  };
  video.style.transform = zoom === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${zoom})`;
  $('zoom-label').textContent = $('quick-zoom').textContent = `%${Math.round(zoom * 100)}`;
}

function zoomAt(z, cx, cy) {
  const ratio = Math.min(MAX_ZOOM, Math.max(1, z)) / view.z;
  setView(z, cx - (cx - view.x) * ratio, cy - (cy - view.y) * ratio);
}

function zoomBy(factor) {
  zoomAt(view.z * factor, innerWidth / 2, innerHeight / 2);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast('Tarayıcı tam ekrana izin vermedi.'));
}

function actualSize() {
  if (!video.videoWidth) return;
  const contained = Math.min(innerWidth / video.videoWidth, innerHeight / video.videoHeight);
  zoomAt(1 / (contained * devicePixelRatio), innerWidth / 2, innerHeight / 2);
}

// object-fit: contain kenar boşluklarını çıkarıp 0..1 ekran koordinatı verir.
function toRemote(clientX, clientY) {
  const r = video.getBoundingClientRect();
  const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight) || 1;
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  return {
    x: (clientX - r.left - (r.width - w) / 2) / w,
    y: (clientY - r.top - (r.height - h) / 2) / h,
  };
}

// Fare
const BUTTON_NAMES = ['left', 'middle', 'right'];
video.addEventListener('mousemove', (e) => {
  // Yakınlaştırılmışken görünüm fareyi takip eder.
  if (view.z > 1) setView(view.z, -(view.z - 1) * e.clientX, -(view.z - 1) * e.clientY);
  send({ t: 'move', ...toRemote(e.clientX, e.clientY) });
});
video.addEventListener('mousedown', (e) => {
  send({ t: 'move', ...toRemote(e.clientX, e.clientY) });
  send({ t: 'down', b: BUTTON_NAMES[e.button] });
});
video.addEventListener('mouseup', (e) => send({ t: 'up', b: BUTTON_NAMES[e.button] }));
video.addEventListener('contextmenu', (e) => e.preventDefault());
video.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Trackpad sıkıştırması tarayıcıya Ctrl+tekerlek olarak gelir.
  if (e.ctrlKey) {
    const z = Math.min(MAX_ZOOM, Math.max(1, view.z * Math.exp(-e.deltaY / 100)));
    setView(z, -(z - 1) * e.clientX, -(z - 1) * e.clientY);
    return;
  }
  const steps = (d) => Math.sign(d) * Math.ceil(Math.abs(d) / 40);
  send({ t: 'scroll', dx: steps(e.deltaX), dy: steps(e.deltaY) });
}, { passive: false });

// Dokunma. Tek parmak: dokun = tık, basılı tut = sağ tık, sürükle = sürükleme
// (izleme dörtgeninde imleci kaydırır). İki parmak: dokun = sağ tık, sıkıştır = zoom,
// sürükle = yakınlaştırılmışken görünümü kaydırır, değilse uzak ekranı kaydırır.
const TAP_SLOP = 8;
const LONG_PRESS_MS = 500;
const PINCH_SLOP = 24;
const SCROLL_STEP = 6;
let touch = null;

const midpoint = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

function clickAt(b) {
  send({ t: 'down', b });
  send({ t: 'up', b });
}

video.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    touch = { startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY, moved: false, dragging: false, two: false, done: false, gesture: null };
    touch.timer = setTimeout(() => {
      if (!touch || touch.moved || touch.two) return;
      touch.done = true;
      if (!trackpad) send({ t: 'move', ...toRemote(touch.x, touch.y) });
      clickAt('right');
    }, LONG_PRESS_MS);
  } else if (touch && e.touches.length === 2) {
    clearTimeout(touch.timer);
    touch.two = true;
    touch.spread = touch.startSpread = spread(e.touches);
    touch.mid = midpoint(e.touches);
  }
}, { passive: false });

function twoFingerMove(touches) {
  const mid = midpoint(touches);
  const dist = spread(touches);
  const dx = mid.x - touch.mid.x;
  const dy = mid.y - touch.mid.y;
  if (!touch.gesture) {
    if (Math.abs(dist - touch.startSpread) > PINCH_SLOP) touch.gesture = 'pinch';
    else if (Math.hypot(dx, dy) >= SCROLL_STEP) touch.gesture = view.z > 1 ? 'pan' : 'scroll';
    else return;
    touch.moved = true;
  }
  if (touch.gesture === 'pinch') {
    zoomAt(view.z * (dist / touch.spread), mid.x, mid.y);
    setView(view.z, view.x + dx, view.y + dy);
  } else if (touch.gesture === 'pan') {
    setView(view.z, view.x + dx, view.y + dy);
  } else {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SCROLL_STEP) return;
    send({ t: 'scroll', dx: Math.round(-dx / SCROLL_STEP), dy: Math.round(-dy / SCROLL_STEP) });
  }
  touch.mid = mid;
  touch.spread = dist;
}

video.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!touch || touch.done) return;
  if (touch.two) {
    if (e.touches.length >= 2) twoFingerMove(e.touches);
    return;
  }
  const t = e.touches[0];
  if (!touch.moved && Math.hypot(t.clientX - touch.startX, t.clientY - touch.startY) < TAP_SLOP) return;
  touch.moved = true;
  clearTimeout(touch.timer);
  if (trackpad) {
    send({ t: 'moveBy', dx: Math.round((t.clientX - touch.x) * 2), dy: Math.round((t.clientY - touch.y) * 2) });
  } else {
    if (!touch.dragging) {
      touch.dragging = true;
      send({ t: 'move', ...toRemote(touch.startX, touch.startY) });
      send({ t: 'down', b: 'left' });
    }
    send({ t: 'move', ...toRemote(t.clientX, t.clientY) });
  }
  touch.x = t.clientX;
  touch.y = t.clientY;
}, { passive: false });

video.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (!touch || e.touches.length) return;
  clearTimeout(touch.timer);
  if (touch.dragging) {
    send({ t: 'up', b: 'left' });
  } else if (!touch.moved && !touch.done) {
    if (touch.two) {
      clickAt('right');
    } else {
      if (!trackpad) send({ t: 'move', ...toRemote(touch.x, touch.y) });
      clickAt('left');
    }
  }
  touch = null;
}, { passive: false });

// Fiziksel klavye
const META_SWAP = { MetaLeft: 'ControlLeft', MetaRight: 'ControlRight', ControlLeft: 'MetaLeft', ControlRight: 'MetaRight' };
const swapCode = (c) => (swapMeta ? META_SWAP[c] ?? c : c);

// Bu kısayollar uzak bilgisayara gitmez: Ctrl+Alt+F, Ctrl+Alt++, Ctrl+Alt+-, Ctrl+Alt+0
const LOCAL_KEYS = {
  KeyF: toggleFullscreen,
  Equal: () => zoomBy(1.25),
  Minus: () => zoomBy(1 / 1.25),
  Digit0: () => setView(1, 0, 0),
};

function onKey(e, t) {
  if ($('session').hidden || !$('panel').hidden) return;
  if (e.ctrlKey && e.altKey && LOCAL_KEYS[e.code]) {
    e.preventDefault();
    if (t === 'kd' && !e.repeat) LOCAL_KEYS[e.code]();
    return;
  }
  if (e.target === $('typing') && (e.keyCode === 229 || !e.code)) return;
  e.preventDefault();
  send({ t, c: swapCode(e.code) });
}
addEventListener('keydown', (e) => onKey(e, 'kd'));
addEventListener('keyup', (e) => onKey(e, 'ku'));
addEventListener('blur', () => send({ t: 'release' }));

// Android klavyesi kelimeyi bütün olarak yeniden yazar, keydown vermez.
// Bu yüzden önceki değerle fark alınır: silinen kısım Backspace, yenisi metin olarak gider.
const typing = $('typing');
let lastTyped = '';
typing.addEventListener('input', () => {
  const now = typing.value;
  let same = 0;
  while (same < now.length && same < lastTyped.length && now[same] === lastTyped[same]) same++;
  for (let i = lastTyped.length - same; i > 0; i--) pressCombo(['Backspace']);
  const added = now.slice(same);
  if (added) send({ t: 'text', s: added });
  lastTyped = now;
  if (now.length > 200) typing.value = lastTyped = '';
});

if (navigator.virtualKeyboard) typing.setAttribute('virtualkeyboardpolicy', 'manual');

function keyboardVisible() {
  const tall = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  const full = innerWidth > innerHeight || screen.orientation?.type.startsWith('landscape') ? short : tall;
  return document.activeElement === typing && (visualViewport?.height ?? innerHeight) < full * 0.75;
}

// Tarayıcı klavyeyi yalnızca dokunuştan sonraki birkaç saniye içinde açar.
function showKeyboard() {
  if (document.activeElement === typing && !navigator.virtualKeyboard) typing.blur();
  typing.focus({ preventScroll: true });
  navigator.virtualKeyboard?.show();
}

function hideKeyboard() {
  navigator.virtualKeyboard?.hide();
  typing.blur();
}

function pressCombo(codes) {
  for (const c of codes) send({ t: 'kd', c });
  for (const c of [...codes].reverse()) send({ t: 'ku', c });
}

function buildKeys() {
  const mac = hostPlatform === 'darwin';
  const mod = mac ? 'MetaLeft' : 'ControlLeft';
  const keys = [
    ['Esc', ['Escape']],
    ['Tab', ['Tab']],
    [mac ? 'Cmd' : 'Win', ['MetaLeft']],
    [mac ? 'Cmd+Tab' : 'Alt+Tab', [mac ? 'MetaLeft' : 'AltLeft', 'Tab']],
    ['Kopyala', [mod, 'KeyC']],
    ['Yapıştır', [mod, 'KeyV']],
    ['Geri al', [mod, 'KeyZ']],
    ['Tümünü seç', [mod, 'KeyA']],
    [mac ? 'Zorla çık' : 'Görev Yön.', mac ? ['MetaLeft', 'AltLeft', 'Escape'] : ['ControlLeft', 'ShiftLeft', 'Escape']],
  ];
  $('keys').replaceChildren(...keys.map(([label, codes]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => pressCombo(codes);
    return b;
  }));
}

// Yan panel
function togglePanel(open) {
  $('panel').hidden = !open;
  $('rail').hidden = open;
  $('tab').setAttribute('aria-expanded', String(open));
  if (open) updateStats();
}

function setTrackpad(on) {
  trackpad = on;
  $('mode-touch').classList.toggle('on', !on);
  $('mode-track').classList.toggle('on', on);
}

function setQualityButtons(fast) {
  $('q-sharp').classList.toggle('on', !fast);
  $('q-fast').classList.toggle('on', fast);
  $('quality-hint').textContent = fast ? 'Gecikme düşük, görüntü akıcı. Video ve hızlı işler için.' : 'Yazılar keskin. Okuma ve ofis işleri için.';
}

function setQuality(fast) {
  fastMode = fast;
  setQualityButtons(fast);
  send({ t: 'quality', fast });
}

$('tab').onclick = $('quick-menu').onclick = () => togglePanel(true);
$('close').onclick = () => togglePanel(false);
$('stage').addEventListener('pointerdown', () => togglePanel(false));
$('end').onclick = () => endSession();
$('fs').onclick = $('quick-fs').onclick = toggleFullscreen;
$('zoom-in').onclick = $('quick-in').onclick = () => zoomBy(1.25);
$('zoom-out').onclick = $('quick-out').onclick = () => zoomBy(1 / 1.25);
$('fit').onclick = $('quick-fit').onclick = () => setView(1, 0, 0);
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  $('fs-label').textContent = on ? 'Tam ekrandan çık' : 'Tam ekran';
  // Tam ekranda Esc ve Alt+Tab gibi tuşlar da uzak bilgisayara gider.
  if (on) navigator.keyboard?.lock?.().catch(() => {});
  else {
    navigator.keyboard?.unlock?.();
    showOrientation('auto');
  }
});
$('actual').onclick = actualSize;
$('display').onchange = (e) => send({ t: 'display', id: e.target.value });
$('mode-touch').onclick = () => setTrackpad(false);
$('mode-track').onclick = () => setTrackpad(true);
$('kb').onclick = () => {
  togglePanel(false);
  showKeyboard();
};
$('rail-kb').onclick = () => {
  autoKeyboard = false;
  if (keyboardVisible()) hideKeyboard();
  else showKeyboard();
};
$('auto-kb').checked = storage.get(AUTO_KB_KEY) !== 'off';
$('auto-kb').onchange = (e) => storage.set(e.target.checked ? 'on' : 'off', AUTO_KB_KEY);

// Ekran yönü: telefon ayarlarından bağımsız. Tarayıcı kilidi yalnızca tam ekranda verir.
function showOrientation(mode) {
  for (const m of ['auto', 'portrait', 'landscape']) $(`o-${m}`).classList.toggle('on', m === mode);
}

async function setOrientation(mode) {
  try {
    if (mode === 'auto') {
      screen.orientation.unlock();
    } else {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await screen.orientation.lock(mode);
    }
    showOrientation(mode);
  } catch {
    toast('Bu tarayıcı ekran yönünü değiştirmeye izin vermiyor.');
  }
}

$('o-auto').onclick = () => setOrientation('auto');
$('o-portrait').onclick = () => setOrientation('portrait');
$('o-landscape').onclick = () => setOrientation('landscape');
$('rail-rotate').onclick = () => setOrientation(innerWidth > innerHeight ? 'portrait' : 'landscape');
$('q-sharp').onclick = () => setQuality(false);
$('q-fast').onclick = () => setQuality(true);
$('sound').onclick = () => {
  video.muted = !video.muted;
  $('sound-label').textContent = video.muted ? 'Sesi aç' : 'Sesi kapat';
};
addEventListener('resize', () => setView(view.z, view.x, view.y));

// Pano
$('clip-send').onclick = async () => {
  try {
    send({ t: 'clip', s: await navigator.clipboard.readText() });
    toast('Pano gönderildi.');
  } catch {
    toast('Tarayıcı pano iznini vermedi.');
  }
};
$('clip-get').onclick = () => navigator.clipboard.writeText(remoteClip)
  .then(() => toast('Uzak pano kopyalandı.'))
  .catch(() => toast('Tarayıcı pano iznini vermedi.'));

// Dosya aktarımı
const FILE_CHUNK = 64 * 1024;
$('upload').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const picked = e.target.files[0];
  e.target.value = '';
  if (!picked || !file) return;
  file.send(JSON.stringify({ start: picked.name, size: picked.size }));
  for (let offset = 0; offset < picked.size; offset += FILE_CHUNK) {
    while (file.bufferedAmount > 1_000_000) await new Promise((r) => setTimeout(r, 20));
    file.send(await picked.slice(offset, offset + FILE_CHUNK).arrayBuffer());
    toast(`Gönderiliyor: %${Math.round((offset / picked.size) * 100)}`, true);
  }
  file.send(JSON.stringify({ end: true }));
};

$('download').onclick = () => {
  toast('Dosyayı uzak ekranda açılan pencereden seç.');
  togglePanel(false);
  send({ t: 'pull-file' });
};

let incoming = null;
function onFileMessage(e) {
  if (typeof e.data !== 'string') {
    incoming.parts.push(e.data);
    incoming.got += e.data.byteLength;
    toast(`Alınıyor: %${Math.round((incoming.got / incoming.size) * 100)}`, true);
    return;
  }
  const msg = JSON.parse(e.data);
  if (msg.start) {
    incoming = { name: msg.start, size: msg.size, got: 0, parts: [] };
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(incoming.parts));
  a.download = incoming.name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`İndirildi: ${incoming.name}`);
  incoming = null;
}

// Başlangıç
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  code = $('code').value.trim();
  $('code').value = '';
  if (code) login();
});
$('logout').onclick = () => {
  code = '';
  storage.clear();
  ws?.close();
  show('login');
};

code = storage.get() ?? '';
if (code) login();
