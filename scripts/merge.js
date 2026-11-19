// Rebuilds data/base.json and data/ids.json from seed/ plus every contribution in contributions/.
// A contribution is made by the site's "Add hands" box: per-hand opponent counts only, no hole cards,
// no amounts, no uploader name. Hands already in the pool are skipped, so re-submitting is harmless.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = require('../engine.js');
const root = path.join(__dirname, '..');
const BLOCK = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'blocked.json'), 'utf8')));
const hash = s => crypto.createHash('sha256').update(String(s).toLowerCase()).digest('hex');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'seed/base.json'), 'utf8'));
const ids = new Set(JSON.parse(fs.readFileSync(path.join(root, 'seed/ids.json'), 'utf8')));
const acc = {counts: seed.counts, last: seed.last};
let hands = seed.hands, added = 0, skipped = 0, rejected = [], merged = 0;
const NF = E.FIELDS.length;
const okId = s => typeof s === 'string' && /^\w{6,40}$/.test(s);
const okDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dir = path.join(root, 'contributions');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
for (const f of files) {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { rejected.push(f + ': not valid JSON'); continue; }
  if (!c || c.format !== 'phenom-scouting-contribution' || !Array.isArray(c.hands)) { rejected.push(f + ': not a contribution file'); continue; }
  merged++;
  for (const h of c.hands) {
    if (!Array.isArray(h) || h.length !== 4) continue;
    const [id, date, fmt, rows] = h;
    if (!okId(id) || !okDate(date) || !['C', 'T'].includes(fmt) || typeof rows !== 'object' || rows === null) continue;
    if (ids.has(id)) { skipped++; continue; }
    const one = {counts: {}, last: {}};
    let bad = false;
    for (const [pg, sparse] of Object.entries(rows)) {
      const cut = pg.lastIndexOf('|'); const p = pg.slice(0, cut), g = pg.slice(cut + 1);
      if (!p || p.length > 40 || !g || g.length > 60 || BLOCK.has(hash(p)) || !Array.isArray(sparse)) { if (BLOCK.has(hash(p))) continue; bad = true; break; }
      const arr = new Array(NF).fill(0);
      for (const pair of sparse) {
        if (!Array.isArray(pair) || pair.length !== 2) { bad = true; break; }
        const [i, v] = pair; if (!Number.isInteger(i) || i < 0 || i >= NF || !Number.isInteger(v) || v < 0 || v > 20) { bad = true; break; }
        arr[i] = v;
      }
      if (bad) break;
      one.counts[fmt + '|' + p + '|' + g] = arr;
      const lk = fmt + '|' + p; if (!one.last[lk] || one.last[lk] < date) one.last[lk] = date;
    }
    if (bad) continue;
    E.merge(acc, one); ids.add(id); hands++; added++;
  }
}
fs.writeFileSync(path.join(root, 'data/base.json'), JSON.stringify({hands, contributions: merged, built: new Date().toISOString().slice(0, 10), fields: E.FIELDS, counts: acc.counts, last: acc.last}));
fs.writeFileSync(path.join(root, 'data/ids.json'), JSON.stringify([...ids]));
console.log(`files ${files.length}, hands added ${added}, already in pool ${skipped}, total ${hands}`);
if (rejected.length) console.log('rejected:\n' + rejected.join('\n'));
