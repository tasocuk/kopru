// Köprü'yü senin Cloudflare hesabına kurar. Kullanım: npm run setup
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const SECRETS_FILE = '.secrets';

function readSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  return Object.fromEntries(fs.readFileSync(SECRETS_FILE, 'utf8').trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

function wrangler(args, input) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    input,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error('\nKurulum durdu. Önce "npx wrangler login" ile giriş yaptığından emin ol.');
    process.exit(1);
  }
  return result.stdout;
}

const secrets = readSecrets();
secrets.ACCESS_CODE ||= crypto.randomBytes(8).toString('hex');
secrets.HOST_TOKEN ||= crypto.randomBytes(32).toString('hex');
if (process.env.TURN_KEY_ID) {
  secrets.TURN_KEY_ID = process.env.TURN_KEY_ID;
  secrets.TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;
}
const body = Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n');
fs.writeFileSync(SECRETS_FILE, `${body}\n`, { mode: 0o600 });

console.log('Cloudflare\'a kuruluyor...');
const output = wrangler(['deploy']);
const url = output.match(/https:\/\/\S+\.workers\.dev/)?.[0];

for (const [key, value] of Object.entries(secrets)) {
  console.log(`${key} kaydediliyor...`);
  wrangler(['secret', 'put', key], value);
}

console.log(`
Kurulum tamamlandı.

  Adres:          ${url ?? 'wrangler deploy çıktısına bak'}
  Erişim kodu:    ${secrets.ACCESS_CODE}
  Cihaz anahtarı: ${secrets.HOST_TOKEN}

Bu bilgiler ${SECRETS_FILE} dosyasında da duruyor. Dosyayı kimseyle paylaşma.
`);
