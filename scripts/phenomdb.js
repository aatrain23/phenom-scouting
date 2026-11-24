// Pulls public tournament records from PhenomDB (phenomdb.com) for players on the scouting cards.
// Runs daily in GitHub Actions; writes data/phenomdb.json. Refreshes the stalest players first,
// a limited number per run, and stays under PhenomDB's 30 requests/minute limit.
// Usage: node scripts/phenomdb.js [maxPlayers]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'phenomdb.json');
const API = 'https://phenomdb.com/api/tournytrack/';
const MIN_HANDS = 50;          // only players with a real scouting card
const MAX = +process.argv[2] || 150;
const GAP_MS = 2600;           // ~23 requests/minute
const STALE_DAYS = 3;          // re-check a player at most every 3 days
const sleep = ms => new Promise(r => setTimeout(r, ms));

function players() {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'base.json'), 'utf8'));
  const n = {};
  for (const [k, v] of Object.entries(b.counts)) { const p = k.split('|')[1]; n[p] = (n[p] || 0) + v[0]; }
  return Object.entries(n).filter(([p, h]) => h >= MIN_HANDS && p !== 'AAtrain').sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {headers: {'User-Agent': 'phenom-scouting (github.com/aatrain23/phenom-scouting)', Accept: 'application/json'}});
    if (r.status === 429) { await sleep(30000); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return r.json();
  }
  throw new Error('rate limited ' + url);
}

const r1 = x => x == null ? null : Math.round(x * 10) / 10;

function summarize(p, rating) {
  const recent = p.recentTournaments || [];
  const games = {};
  const ALIAS = {'No Limit Holdem': 'NLHE', 'No Limit Hold\'em': 'NLHE'};
  recent.forEach(t => { const g = ALIAS[t.gameType] || t.gameType; if (g && g !== 'Unknown') games[g] = (games[g] || 0) + 1; });
  const since = Date.now() - 30 * 864e5;
  const last30 = recent.filter(t => Date.parse(t.date) >= since);
  const out = {
    n: p.nickname, tp: p.tournamentsPlayed, net: Math.round(p.netProfit), roi: r1(p.roi), itm: r1(p.itmPercentage),
    w: p.firstPlaceFinishes, ab: r1(p.avgBuyIn), big: Math.round(p.biggestWin || 0),
    last: p.lastTournamentDate ? p.lastTournamentDate.slice(0, 10) : null,
    g: Object.entries(games).sort((a, b) => b[1] - a[1]).slice(0, 4),
    m30: {n: last30.length, net: Math.round(last30.reduce((s, t) => s + (t.profit || 0), 0))},
  };
  if (rating && rating.found && rating.player) {
    out.rank = rating.player.rank; out.of = rating.player.totalRankedPlayers; out.rt = r1(rating.player.abilityRating); out.q = !!rating.qualified;
  }
  return out;
}

(async () => {
  let db = {updated: null, source: 'https://phenomdb.com', players: {}};
  try { db = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const now = Date.now();
  const due = players().filter(p => { const e = db.players[p]; return !e || now - Date.parse(e.f) > STALE_DAYS * 864e5; })
    .sort((a, b) => (db.players[a] ? Date.parse(db.players[a].f) : 0) - (db.players[b] ? Date.parse(db.players[b].f) : 0))
    .slice(0, MAX);
  let ok = 0, miss = 0, fail = 0;
  for (const p of due) {
    try {
      const j = await get(API + 'player?query=' + encodeURIComponent(p));
      await sleep(GAP_MS);
      const f = new Date().toISOString();
      const pl = j && j.success && j.player;
      if (!pl || String(pl.nickname).toLowerCase() !== p.toLowerCase()) { db.players[p] = {nf: 1, f}; miss++; continue; }
      if (pl.isPrivate) { db.players[p] = {priv: 1, f}; miss++; continue; }
      let rating = null;
      if (pl.tournamentsPlayed > 0 && pl.address) { rating = await get(API + 'player-rating?address=' + pl.address); await sleep(GAP_MS); }
      db.players[p] = {...summarize(pl, rating), f};
      ok++;
    } catch (e) { fail++; console.error(p, e.message); if (fail >= 8) break; }
  }
  db.updated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(db));
  console.log(`checked ${due.length}: ${ok} found, ${miss} not on PhenomDB or private, ${fail} errors; ${Object.keys(db.players).length} stored`);
  if (fail >= 8 && ok === 0) process.exit(1);
})();
