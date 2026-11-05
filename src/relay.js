const WebSocket = require('ws');

const PONG_TIMEOUT_MS = 70_000;

// Mac/Windows dışarıya bağlanır, böylece modemde port açmak gerekmez.
// on: { status(online), clientConnected(iceServers), signal(data), clientLeft() }
function createRelay({ url, token, id, name, platform, on }) {
  let ws;
  let closed = false;
  let retry = 1000;
  let lastPong = 0;
  let timer;

  function connect() {
    const target = new URL('/ws/host', url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.search = new URLSearchParams({ id, name, platform });
    ws = new WebSocket(target, { headers: { Authorization: `Bearer ${token}` } });

    ws.on('open', () => {
      retry = 1000;
      lastPong = Date.now();
      on.status(true);
      timer = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) return ws.terminate();
        ws.send('ping');
      }, 30_000);
    });
    ws.on('message', (raw) => {
      const text = String(raw);
      if (text === 'pong') { lastPong = Date.now(); return; }
      const msg = JSON.parse(text);
      if (msg.type === 'client-connected') on.clientConnected(msg.iceServers);
      if (msg.type === 'signal') on.signal(msg.data);
      if (msg.type === 'client-left') on.clientLeft();
    });
    ws.on('close', () => {
      clearInterval(timer);
      on.status(false);
      on.clientLeft();
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
    ws.on('error', (e) => console.error('relay:', e.message));
  }

  connect();

  const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  return {
    sendSignal: (data) => send({ type: 'signal', data }),
    kick: () => send({ type: 'kick' }),
    close: () => { closed = true; ws?.close(); },
  };
}

module.exports = { createRelay };
