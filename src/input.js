const { mouse, keyboard, Key, Button } = require('@nut-tree-fork/nut-js');

mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

const BUTTONS = { left: Button.LEFT, middle: Button.MIDDLE, right: Button.RIGHT };

// KeyboardEvent.code -> nut.js. Fiziksel tuş gönderiliyor, böylece Türkçe Q gibi
// düzenler iki tarafta aynıysa ğ, ü, ş da doğru çıkar.
const KEYS = {
  Escape: 'Escape', Tab: 'Tab', CapsLock: 'CapsLock', Space: 'Space', Enter: 'Enter',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt',
  AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', Backquote: 'Grave',
  Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket',
  Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma',
  Period: 'Period', Slash: 'Slash',
};
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYS[`Key${c}`] = c;
for (let i = 0; i <= 9; i++) KEYS[`Digit${i}`] = `Num${i}`;
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = `F${i}`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

// getDisplay: () => { bounds, scaleFactor }
function createInput(getDisplay) {
  const heldKeys = new Set();
  const heldButtons = new Set();
  let queue = Promise.resolve();
  let pendingMove = null;

  const enqueue = (fn) => {
    queue = queue.then(fn).catch((e) => console.error('input:', e.message));
  };

  function toScreen(x, y) {
    const { bounds, scaleFactor } = getDisplay();
    // nut.js Windows'ta fiziksel piksel, Mac'te mantıksal nokta kullanır.
    const s = process.platform === 'win32' ? scaleFactor : 1;
    return {
      x: Math.round((bounds.x + clamp(x, 0, 1) * bounds.width) * s),
      y: Math.round((bounds.y + clamp(y, 0, 1) * bounds.height) * s),
    };
  }

  function handle(ev) {
    switch (ev?.t) {
      case 'move':
        // Kuyruk şişmesin: bekleyen hareket varsa sadece hedefini güncelle.
        if (!pendingMove) {
          enqueue(async () => {
            const p = pendingMove;
            pendingMove = null;
            await mouse.setPosition(toScreen(p.x, p.y));
          });
        }
        pendingMove = { x: ev.x, y: ev.y };
        break;
      case 'moveBy':
        enqueue(async () => {
          const p = await mouse.getPosition();
          await mouse.setPosition({
            x: p.x + clamp(ev.dx, -500, 500),
            y: p.y + clamp(ev.dy, -500, 500),
          });
        });
        break;
      case 'down':
      case 'up': {
        const b = BUTTONS[ev.b];
        if (b === undefined) return;
        if (ev.t === 'down') {
          heldButtons.add(b);
          enqueue(() => mouse.pressButton(b));
        } else {
          heldButtons.delete(b);
          enqueue(() => mouse.releaseButton(b));
        }
        break;
      }
      case 'scroll': {
        const dy = Math.round(clamp(ev.dy, -200, 200));
        const dx = Math.round(clamp(ev.dx, -200, 200));
        if (dy) enqueue(() => (dy > 0 ? mouse.scrollDown(dy) : mouse.scrollUp(-dy)));
        if (dx) enqueue(() => (dx > 0 ? mouse.scrollRight(dx) : mouse.scrollLeft(-dx)));
        break;
      }
      case 'kd':
      case 'ku': {
        const k = Key[KEYS[ev.c]];
        if (k === undefined) return;
        if (ev.t === 'kd') {
          heldKeys.add(k);
          enqueue(() => keyboard.pressKey(k));
        } else {
          heldKeys.delete(k);
          enqueue(() => keyboard.releaseKey(k));
        }
        break;
      }
      case 'text':
        if (typeof ev.s === 'string' && ev.s.length <= 2000) enqueue(() => keyboard.type(ev.s));
        break;
      case 'release':
        releaseAll();
        break;
    }
  }

  // Bağlantı koparsa takılı kalan tuş/tık bırakılır.
  function releaseAll() {
    for (const k of heldKeys) enqueue(() => keyboard.releaseKey(k));
    for (const b of heldButtons) enqueue(() => mouse.releaseButton(b));
    heldKeys.clear();
    heldButtons.clear();
  }

  return { handle, releaseAll };
}

module.exports = { createInput, KEYS };
