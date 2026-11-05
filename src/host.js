const $ = (id) => document.getElementById(id);
const QUALITY = {
  // Net: yazı keskin kalır, hareket yoğunken kare hızı düşebilir.
  sharp: { bitrate: 30_000_000, fps: 30, degradation: 'maintain-resolution', hint: 'detail', maxWidth: Infinity },
  // Hızlı: gecikme ve akıcılık önceliklidir, çözünürlük gerektiğinde düşer.
  fast: { bitrate: 8_000_000, fps: 60, degradation: 'maintain-framerate', hint: 'motion', maxWidth: 1920 },
};
let pc;
let stream;
let sender;
let input;
let file;
let fast = false;
let online = false;

let editing = false;

function render() {
  $('status-card').className = `status ${pc ? 'busy' : online ? 'online' : ''}`;
  $('status').textContent = pc ? 'Uzak bağlantı açık' : online ? 'Bağlantı bekleniyor' : 'Sunucuya bağlanılıyor';
  $('status-hint').textContent = pc ? 'Bu ekran şu anda paylaşılıyor.' : online ? 'Cihazın listede görünüyor.' : 'İnternet bağlantını ve ayarları kontrol et.';
  $('kick').hidden = !pc;
}

function showInfo(i) {
  online = i.online;
  const setup = !i.configured || editing;
  $('setup').hidden = !setup;
  $('ready').hidden = setup;
  $('cancel').hidden = !i.configured;
  $('name').value ||= i.name;
  $('url').value ||= i.url ?? '';
  $('device').textContent = i.configured ? i.name : 'Kurulum';
  if (!i.configured) return;
  $('qr').src = i.qr;
  $('link').textContent = i.url.replace(/^https?:\/\//, '');
  $('link').onclick = (e) => {
    e.preventDefault();
    window.kopru.send('open-url', i.url);
  };
  $('login').checked = i.openAtLogin;
  $('login-row').hidden = !i.canAutostart;
  const missing = [!i.perms.screen && 'Ekran Kaydı', !i.perms.input && 'Erişilebilirlik'].filter(Boolean);
  $('perms').hidden = missing.length === 0;
  $('perm-list').replaceChildren(...missing.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  if (!i.perms.input) window.kopru.send('ask-input-permission');
  render();
}

function cleanup() {
  pc?.close();
  pc = sender = input = file = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  render();
}

async function capture() {
  const audio = navigator.userAgent.includes('Windows');
  const next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 60 } }, audio });
  return next;
}

async function applyQuality() {
  const q = fast ? QUALITY.fast : QUALITY.sharp;
  sender.track.contentHint = q.hint;
  const { width = q.maxWidth } = sender.track.getSettings();
  const params = sender.getParameters();
  params.degradationPreference = q.degradation;
  params.encodings[0].maxBitrate = q.bitrate;
  params.encodings[0].maxFramerate = q.fps;
  params.encodings[0].scaleResolutionDownBy = Math.max(1, width / q.maxWidth);
  await sender.setParameters(params);
}

// Varsayılan başlangıç hızı düşük olduğu için görüntü ilk saniyelerde bulanık kalır.
function raiseStartBitrate(sdp) {
  return sdp.split(/(?=^m=)/m).map((section) => (
    section.startsWith('m=video')
      ? section.replace(/^(a=fmtp:\d+ (?!apt=).*)$/gm, '$1;x-google-start-bitrate=8000;x-google-min-bitrate=1000')
      : section
  )).join('');
}

async function switchDisplay(id) {
  const displays = await window.kopru.invoke('select-display', id);
  const next = await capture();
  await sender.replaceTrack(next.getVideoTracks()[0]);
  stream.getTracks().forEach((t) => t.stop());
  stream = next;
  await applyQuality();
  input.send(JSON.stringify({ t: 'displays', ...displays }));
}

async function sendDownload() {
  const picked = await window.kopru.invoke('pick-file');
  if (!picked) return;
  file.send(JSON.stringify({ start: picked.name, size: picked.size }));
  for (let offset = 0; ;) {
    const chunk = await window.kopru.invoke('read-chunk', offset);
    if (!chunk.byteLength) break;
    while (file.bufferedAmount > 1_000_000) await new Promise((r) => setTimeout(r, 20));
    file.send(chunk);
    offset += chunk.byteLength;
  }
  file.send(JSON.stringify({ end: true }));
}

function onControl(e) {
  const ev = JSON.parse(e.data);
  switch (ev.t) {
    case 'quality':
      fast = ev.fast === true;
      applyQuality();
      break;
    case 'display':
      switchDisplay(ev.id).catch((err) => console.error(err));
      break;
    case 'clip':
      window.kopru.send('clip-set', ev.s);
      break;
    case 'pull-file':
      sendDownload().catch((err) => console.error(err));
      break;
    default:
      window.kopru.send('input', ev);
  }
}

function onFile(e) {
  if (typeof e.data !== 'string') return window.kopru.send('file-chunk', e.data);
  const msg = JSON.parse(e.data);
  window.kopru.send(msg.start ? 'file-begin' : 'file-end', msg.start);
}

async function start(iceServers) {
  cleanup();
  stream = await capture();
  pc = new RTCPeerConnection({ iceServers });
  render();

  input = pc.createDataChannel('input', { ordered: true });
  file = pc.createDataChannel('file', { ordered: true });
  file.binaryType = 'arraybuffer';
  input.onmessage = onControl;
  file.onmessage = onFile;
  input.onopen = async () => input.send(JSON.stringify({ t: 'displays', ...(await window.kopru.invoke('displays')) }));

  const transceiver = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
  sender = transceiver.sender;
  const codecs = RTCRtpSender.getCapabilities('video').codecs;
  const isH264 = (c) => c.mimeType === 'video/H264';
  transceiver.setCodecPreferences([...codecs.filter(isH264), ...codecs.filter((c) => !isH264(c))]);
  await applyQuality();
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

  pc.onicecandidate = (e) => e.candidate && window.kopru.send('signal', { candidate: e.candidate.toJSON() });
  await pc.setLocalDescription(await pc.createOffer());
  window.kopru.send('signal', { description: pc.localDescription.toJSON() });
}

window.kopru.on('info', showInfo);
window.kopru.on('client-connected', (iceServers) => {
  start(iceServers).catch((e) => {
    console.error(e);
    cleanup();
    window.kopru.send('signal', { error: 'Ekran alınamadı. Karşı cihazdaki izinleri kontrol et.' });
    window.kopru.send('kick');
  });
});
window.kopru.on('client-left', cleanup);
window.kopru.on('to-client', (msg) => input?.readyState === 'open' && input.send(JSON.stringify(msg)));
window.kopru.on('signal', async (data) => {
  if (!pc) return;
  if (data.description) {
    await pc.setRemoteDescription({ type: data.description.type, sdp: raiseStartBitrate(data.description.sdp) });
  }
  if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
});

$('kick').onclick = () => window.kopru.send('kick');
$('login').onchange = (e) => window.kopru.send('open-at-login', e.target.checked);
$('edit').onclick = async () => {
  editing = true;
  showInfo(await window.kopru.invoke('info'));
};
$('cancel').onclick = async () => {
  editing = false;
  showInfo(await window.kopru.invoke('info'));
};
$('setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-error').hidden = true;
  try {
    const info = await window.kopru.invoke('save-config', { url: $('url').value, token: $('token').value, name: $('name').value });
    editing = false;
    $('token').value = '';
    showInfo(info);
  } catch {
    $('setup-error').textContent = 'Sunucu adresi geçersiz.';
    $('setup-error').hidden = false;
  }
});
window.kopru.invoke('info').then(showInfo);
