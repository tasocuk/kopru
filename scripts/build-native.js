// Mac'te yazı alanı algılama yardımcısını derler. Swift yoksa özellik kapalı kalır.
const { spawnSync } = require('child_process');

if (process.platform === 'darwin') {
  const result = spawnSync('swiftc', ['-O', 'native/focus-mac.swift', '-o', 'native/focus-mac'], { stdio: 'inherit' });
  if (result.status !== 0) console.warn('focus-mac derlenemedi, otomatik klavye bu Mac\'te çalışmayacak.');
}
