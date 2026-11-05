const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const PORT = 8799;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CODE = 'test-kod';
const TOKEN = 'test-anahtar';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (ws) => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

// Tüm mesajları biriktirir, belirli tipi bekler.
function track(ws) {
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    if (String(raw) === 'pong') return;
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.next = (type) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ type, resolve }));
  };
  return ws;
}

const host = (id, token = TOKEN) => track(new WebSocket(`ws://127.0.0.1:${PORT}/ws/host?id=${id}&name=${id}&platform=darwin`, { headers: { Authorization: `Bearer ${token}` } }));
const client = (origin = ORIGIN) => track(new WebSocket(`ws://127.0.0.1:${PORT}/ws/client`, { origin }));
async function authed() {
  const c = client();
  await open(c);
  c.send(JSON.stringify({ type: 'auth', code: CODE }));
  return [c, await c.next('ok')];
}

test('hub', async (t) => {
  const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--var', `ACCESS_CODE:${CODE}`, '--var', `HOST_TOKEN:${TOKEN}`], { stdio: 'pipe', detached: true });
  t.after(() => process.kill(-dev.pid));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* henüz açılmadı */ }
    await sleep(500);
  }

  await t.test('yanlış anahtarla host, yabancı origin reddedilir', async () => {
    await assert.rejects(open(host('x', 'yanlis')));
    await assert.rejects(open(client('http://evil.example')));
  });

  await t.test('yanlış kod kabul edilmez', async () => {
    const c = client();
    await open(c);
    c.send(JSON.stringify({ type: 'auth', code: 'yok' }));
    assert.equal((await c.next('denied')).reason, 'bad-code');
  });

  await t.test('doğrulanmadan bağlanılamaz', async () => {
    const h = host('m1');
    await open(h);
    const c = client();
    await open(c);
    c.send(JSON.stringify({ type: 'connect', device: 'm1' }));
    await new Promise((r) => c.once('close', r));
    h.close();
    await sleep(100);
  });

  await t.test('liste, eşleşme, sinyal ve ayrılma', async () => {
    const h = host('m2');
    await open(h);
    const [c, ok] = await authed();
    assert.deepEqual(ok.devices.map((d) => d.id), ['m2']);

    c.send(JSON.stringify({ type: 'connect', device: 'm2' }));
    assert.equal((await c.next('connected')).hostPlatform, 'darwin');
    assert.ok((await h.next('client-connected')).iceServers.length);

    h.send(JSON.stringify({ type: 'signal', data: { a: 1 } }));
    assert.deepEqual((await c.next('signal')).data, { a: 1 });
    c.send(JSON.stringify({ type: 'signal', data: { b: 2 } }));
    assert.deepEqual((await h.next('signal')).data, { b: 2 });

    // İkinci istemci eskisini düşürür.
    const [c2] = await authed();
    c2.send(JSON.stringify({ type: 'connect', device: 'm2' }));
    assert.equal((await c.next('session-ended')).reason, 'replaced');
    await c2.next('connected');

    // Host giderse istemci haberdar olur.
    h.close();
    assert.equal((await c2.next('session-ended')).reason, 'offline');
    c.close();
    c2.close();
  });
});
