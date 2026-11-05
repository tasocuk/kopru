import { DurableObject } from 'cloudflare:workers';

const MAX_FAILS = 10;
const LOCK_MS = 10 * 60_000;

async function sameSecret(a, b) {
  const hash = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/ws/')) return env.ASSETS.fetch(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade required', { status: 426 });

    if (url.pathname === '/ws/client') {
      if (req.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    } else if (url.pathname === '/ws/host') {
      const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
      if (!(await sameSecret(token, env.HOST_TOKEN))) return new Response('Forbidden', { status: 403 });
    } else {
      return new Response('Not found', { status: 404 });
    }
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
  },
};

// Tüm cihazlar ve istemciler tek nesnede buluşur. Durum soketlerin üzerinde
// tutulur, böylece nesne uykuya geçip uyansa da kaybolmaz.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [peer, server] = Object.values(new WebSocketPair());
    if (url.pathname === '/ws/host') {
      const id = url.searchParams.get('id')?.slice(0, 64);
      if (!id) return new Response('Bad request', { status: 400 });
      for (const old of this.ctx.getWebSockets(`host:${id}`)) old.close(4000, 'replaced');
      this.ctx.acceptWebSocket(server, ['host', `host:${id}`]);
      server.serializeAttachment({
        role: 'host',
        id,
        name: url.searchParams.get('name')?.slice(0, 64) || 'Cihaz',
        platform: url.searchParams.get('platform') === 'darwin' ? 'darwin' : 'win32',
        client: null,
      });
      this.broadcastDevices();
    } else {
      const cid = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ['client', `client:${cid}`]);
      server.serializeAttachment({
        role: 'client',
        cid,
        ip: req.headers.get('CF-Connecting-IP') ?? 'local',
        authed: false,
        device: null,
      });
    }
    return new Response(null, { status: 101, webSocket: peer });
  }

  hosts() {
    return this.ctx.getWebSockets('host').filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  host(id) {
    return this.ctx.getWebSockets(`host:${id}`).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  client(cid) {
    return this.ctx.getWebSockets(`client:${cid}`).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  devices() {
    return this.hosts().map((ws) => {
      const a = ws.deserializeAttachment();
      return { id: a.id, name: a.name, platform: a.platform, busy: Boolean(a.client) };
    });
  }

  broadcastDevices() {
    const msg = JSON.stringify({ type: 'devices', devices: this.devices() });
    for (const ws of this.ctx.getWebSockets('client')) {
      if (ws.readyState === WebSocket.OPEN && ws.deserializeAttachment().authed) ws.send(msg);
    }
  }

  async iceServers() {
    const stun = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    if (!this.env.TURN_KEY_ID) return stun;
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) return stun;
    return (await res.json()).iceServers;
  }

  unlink(clientWs, notice) {
    const a = clientWs.deserializeAttachment();
    if (!a.device) return;
    const host = this.host(a.device);
    a.device = null;
    clientWs.serializeAttachment(a);
    if (host) {
      const h = host.deserializeAttachment();
      if (h.client === a.cid) {
        h.client = null;
        host.serializeAttachment(h);
        host.send(JSON.stringify({ type: 'client-left' }));
      }
    }
    if (notice && clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: 'session-ended', reason: notice }));
    this.broadcastDevices();
  }

  async auth(ws, att, msg) {
    const key = `fails:${att.ip}`;
    const entry = (await this.ctx.storage.get(key)) ?? { n: 0, until: 0 };
    if (Date.now() < entry.until) {
      ws.send(JSON.stringify({ type: 'denied', reason: 'locked' }));
      return ws.close(4001, 'locked');
    }
    if (!(await sameSecret(msg.code, this.env.ACCESS_CODE))) {
      entry.n += 1;
      if (entry.n >= MAX_FAILS) Object.assign(entry, { n: 0, until: Date.now() + LOCK_MS });
      await this.ctx.storage.put(key, entry);
      ws.send(JSON.stringify({ type: 'denied', reason: 'bad-code' }));
      return ws.close(4001, 'bad-code');
    }
    await this.ctx.storage.delete(key);
    att.authed = true;
    ws.serializeAttachment(att);
    ws.send(JSON.stringify({ type: 'ok', devices: this.devices() }));
  }

  async connect(ws, att, msg) {
    const host = this.host(msg.device);
    if (!host) return ws.send(JSON.stringify({ type: 'session-ended', reason: 'offline' }));
    this.unlink(ws);

    const h = host.deserializeAttachment();
    // Yeni bağlantı eskisini düşürür: telefon uykuya girince oturum kilitli kalmasın.
    const previous = h.client && this.client(h.client);
    if (previous) this.unlink(previous, 'replaced');

    const iceServers = await this.iceServers();
    const fresh = host.deserializeAttachment();
    fresh.client = att.cid;
    host.serializeAttachment(fresh);
    att.device = msg.device;
    ws.serializeAttachment(att);
    ws.send(JSON.stringify({ type: 'connected', iceServers, hostPlatform: fresh.platform, name: fresh.name }));
    host.send(JSON.stringify({ type: 'client-connected', iceServers }));
    this.broadcastDevices();
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(1003, 'bad json'); }
    const att = ws.deserializeAttachment();

    if (att.role === 'host') {
      const client = att.client && this.client(att.client);
      if (!client) return;
      if (msg.type === 'signal') client.send(JSON.stringify({ type: 'signal', data: msg.data }));
      if (msg.type === 'kick') this.unlink(client, 'kicked');
      return;
    }

    if (!att.authed) {
      if (msg.type !== 'auth') return ws.close(4001, 'auth required');
      return this.auth(ws, att, msg);
    }
    if (msg.type === 'connect') return this.connect(ws, att, msg);
    if (msg.type === 'disconnect') return this.unlink(ws);
    if (msg.type === 'signal' && att.device) {
      this.host(att.device)?.send(JSON.stringify({ type: 'signal', data: msg.data }));
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att.role === 'client') return this.unlink(ws);
    const client = att.client && this.client(att.client);
    if (client) {
      const c = client.deserializeAttachment();
      c.device = null;
      client.serializeAttachment(c);
      client.send(JSON.stringify({ type: 'session-ended', reason: 'offline' }));
    }
    this.broadcastDevices();
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
