const test = require('node:test');
const assert = require('node:assert');
const { Key } = require('@nut-tree-fork/nut-js');
const { KEYS } = require('../src/input');

test('tüm tuşlar nut.js karşılığına sahip', () => {
  for (const [code, name] of Object.entries(KEYS)) assert.notEqual(Key[name], undefined, code);
});
