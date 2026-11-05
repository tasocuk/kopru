const { app, BrowserWindow, Notification, clipboard, nativeTheme, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { createRelay } = require('./relay');
const { createInput } = require('./input');

if (process.env.KOPRU_USERDATA) app.setPath('userData', process.env.KOPRU_USERDATA);

// Yoksa WebRTC yerel IP yerine .local adı verir ve Android bunu çözemez.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const CHUNK = 64 * 1024;
let win;
let relay;
let input;
let online = false;
let displayId = null;
let lastClip = '';
let clipTimer;
let upload;
let download;

const configPath = () => path.join(app.getPath('userData'), 'cloud.json');
const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
};
const toRenderer = (name, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(name, data);
};

function currentDisplay() {
  return screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
}

function permissions() {
  if (process.platform !== 'darwin') return { screen: true, input: true };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    input: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

async function info() {
  const config = readConfig();
  return {
    configured: Boolean(config),
    name: config?.name ?? os.hostname().replace(/\.local$/, ''),
    url: config?.url,
    qr: config ? await QRCode.toDataURL(config.url, { margin: 1, width: 240 }) : null,
    online,
    perms: permissions(),
    canAutostart: app.isPackaged,
    openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
  };
}

// Electron 45'te dönüş değeri Promise olabiliyor.
async function readClipboard() {
  const text = await clipboard.readText();
  return typeof text === 'string' ? text : '';
}

function startRelay() {
  const config = readConfig();
  if (!config) return;
  relay?.close();
  relay = createRelay({
    ...config,
    platform: process.platform,
    on: {
      status: async (value) => {
        online = value;
        toRenderer('info', await info());
      },
      clientConnected: async (iceServers) => {
        new Notification({ title: 'Köprü', body: 'Uzak bağlantı başladı' }).show();
        toRenderer('client-connected', iceServers);
        lastClip = await readClipboard();
        clipTimer = setInterval(async () => {
          const text = await readClipboard();
          if (text === lastClip) return;
          lastClip = text;
          if (text.length <= 100_000) toRenderer('to-client', { t: 'clip', s: text });
        }, 1000);
      },
      signal: (data) => toRenderer('signal', data),
      clientLeft: () => {
        clearInterval(clipTimer);
        input.releaseAll();
        upload?.stream.destroy();
        upload = null;
        toRenderer('client-left');
      },
    },
  });
}

function savePath(name) {
  const clean = path.basename(String(name).replace(/[\\/:*?"<>|\0]/g, '_')) || 'dosya';
  const { name: stem, ext } = path.parse(clean);
  const dir = app.getPath('downloads');
  let target = path.join(dir, clean);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  return target;
}

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return {
    current: currentDisplay().id,
    list: screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      name: `Ekran ${i + 1}${d.id === primary ? ' (ana)' : ''} ${d.size.width}×${d.size.height}`,
    })),
  };
}

app.requestSingleInstanceLock() || app.quit();

app.whenReady().then(async () => {
  input = createInput(currentDisplay);

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const index = screen.getAllDisplays().findIndex((d) => d.id === currentDisplay().id);
      const source = sources.find((s) => s.display_id === String(currentDisplay().id)) ?? sources[index] ?? sources[0];
      callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    } catch (e) {
      console.error('Ekran kaynağı alınamadı:', e.message, permissions());
      callback({}); // İzin yoksa Mac kaynak vermez; getDisplayMedia hata döner.
    }
  });

  ipcMain.handle('info', info);
  ipcMain.handle('save-config', (_e, { url, token, name }) => {
    const config = { url: new URL(url).origin, token: token.trim(), name: name.trim() || os.hostname(), id: readConfig()?.id ?? crypto.randomUUID() };
    online = false;
    fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 });
    startRelay();
    return info();
  });
  ipcMain.handle('displays', listDisplays);
  ipcMain.handle('select-display', (_e, id) => {
    displayId = Number(id);
    return listDisplays();
  });
  ipcMain.handle('pick-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (canceled) return null;
    download = fs.openSync(filePaths[0], 'r');
    return { name: path.basename(filePaths[0]), size: fs.fstatSync(download).size };
  });
  ipcMain.handle('read-chunk', (_e, offset) => {
    const buf = Buffer.alloc(CHUNK);
    const n = fs.readSync(download, buf, 0, CHUNK, offset);
    if (n === 0) fs.closeSync(download);
    return buf.subarray(0, n);
  });

  ipcMain.on('signal', (_e, data) => relay?.sendSignal(data));
  ipcMain.on('kick', () => relay?.kick());
  ipcMain.on('input', (_e, ev) => input.handle(ev));
  ipcMain.on('clip-set', (_e, text) => {
    if (typeof text !== 'string' || text.length > 100_000) return;
    lastClip = text;
    clipboard.writeText(text);
  });
  ipcMain.on('file-begin', (_e, name) => {
    const target = savePath(name);
    upload = { target, stream: fs.createWriteStream(target) };
  });
  ipcMain.on('file-chunk', (_e, data) => upload?.stream.write(Buffer.from(data)));
  ipcMain.on('file-end', () => {
    const done = upload;
    upload = null;
    done?.stream.end(() => toRenderer('to-client', { t: 'saved', name: path.basename(done.target) }));
  });
  ipcMain.on('ask-input-permission', () => systemPreferences.isTrustedAccessibilityClient(true));
  // Tek dosyalık Windows sürümü geçici klasörden çalışır, gerçek konum bu değişkendedir.
  ipcMain.on('open-at-login', (_e, on) => app.setLoginItemSettings({
    openAtLogin: Boolean(on),
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  }));
  ipcMain.on('open-url', (_e, url) => /^https?:/.test(url) && shell.openExternal(url));

  win = new BrowserWindow({
    width: 400,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1216' : '#f5f6f8',
    title: 'Köprü',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname, 'host.html'));
  startRelay();
  win.on('focus', async () => toRenderer('info', await info()));
});

app.on('before-quit', () => {
  input?.releaseAll();
  relay?.close();
});
app.on('window-all-closed', () => app.quit());
