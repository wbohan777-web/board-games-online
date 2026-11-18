'use strict';
// 审计：把 spec.json 里所有效果串与 effects.js 的解析器做差集
const path = require('path');
const s = require(path.join(__dirname, 'forest-shuffle', 'spec.json'));
const E = require(path.join(__dirname, 'forest-shuffle', 'effects.js'));

const groups = ['base', 'alpine', 'woodland'];
const uniq = new Map();          // key = field|string
const unsupported = [];
const persistentList = [];

for (const g of groups) {
  for (const c of (s.cards[g] || [])) {
    for (const f of ['immediate', 'bonus']) {
      const v = c[f];
      if (!v || v === 'Effekt::Keiner') continue;
      const key = f + '|' + v;
      if (!uniq.has(key)) uniq.set(key, []);
      uniq.get(key).push(g + ':' + c.ident);
      const e = E.parseEffect(v);
      if (e.kind === 'unsupported') {
        unsupported.push({ group: g, ident: c.ident, field: f, raw: v, kind: e.kind });
      }
    }
    if (c.persistent && c.persistent !== 'Dauereffekt::Keiner') {
      const pe = E.parsePersistent(c.persistent);
      persistentList.push({ group: g, ident: c.ident, raw: c.persistent, parsed: pe });
    }
  }
}

console.log('=== distinct immediate+bonus strings: ' + uniq.size + ' ===');
for (const [k, owners] of uniq) console.log(k, '<=', owners.join(', '));

console.log('');
console.log('=== unsupported / conditional: ' + unsupported.length + ' ===');
for (const u of unsupported) {
  console.log(u.field.padEnd(9), u.group.padEnd(9), String(u.ident).padEnd(26), u.kind.padEnd(12), u.raw);
}

console.log('');
console.log('=== persistent effects: ' + persistentList.length + ' ===');
for (const p of persistentList) console.log(p.group.padEnd(9), String(p.ident).padEnd(26), p.raw);