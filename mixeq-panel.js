/* MixEq — Monte Carlo equity engine for mixed games.
   Games: 2-7 Triple Draw ("27td"), 2-7 Single Draw ("27sd"), Badugi ("badugi"),
          Seven Card Stud ("stud"), Stud Hi-Lo 8 ("stud8"), Razz ("razz").
   Showdown equity only (everyone sees the end). Draw games play every unknown/
   future draw with a rule-based strategy you can tune per player.
   Cards: "As","Td","7h","2c". Ranks 23456789TJQKA, suits shdc. */
(function (root) {
  "use strict";
  const RANKS = "23456789TJQKA", SUITS = "shdc";
  const parseCard = (s) => {
    const r = RANKS.indexOf(s[0].toUpperCase()), u = SUITS.indexOf(s[1].toLowerCase());
    if (r < 0 || u < 0) throw new Error("Bad card: " + s);
    return r * 4 + u;
  };
  const cardStr = (c) => RANKS[c >> 2] + SUITS[c & 3];
  const rk = (c) => c >> 2, st = (c) => c & 3;
  // Parse "AsKd x 7h" or "AsKd??" — returns {known:[], unknown:n}
  function parseHand(str) {
    const s = String(str || "").replace(/[\s,]+/g, "");
    const known = []; let unknown = 0;
    for (let i = 0; i < s.length;) {
      if (s[i] === "x" || s[i] === "X" || s[i] === "?") { unknown++; i++; continue; }
      known.push(parseCard(s.slice(i, i + 2))); i += 2;
    }
    return { known, unknown };
  }
  const parseCards = (str) => parseHand(str).known;

  // ---------- RNG (seedable for tests) ----------
  function rng(seed) {
    if (seed == null) return Math.random;
    let a = seed >>> 0;
    return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  class Deck {
    constructor(exclude, rand) { this.rand = rand; const ex = new Set(exclude); this.cards = [];
      for (let c = 0; c < 52; c++) if (!ex.has(c)) this.cards.push(c); this.n = this.cards.length; this.muck = []; }
    draw() { // partial Fisher-Yates from the remaining stub
      if (this.n === 0) { // reshuffle the muck (draw games)
        if (!this.muck.length) throw new Error("Deck exhausted");
        this.cards = this.muck; this.muck = []; this.n = this.cards.length; }
      const i = Math.floor(this.rand() * this.n); const c = this.cards[i];
      this.cards[i] = this.cards[this.n - 1]; this.cards[this.n - 1] = c; this.n--; return c; }
    remove(c) { const i = this.cards.indexOf(c); if (i >= 0 && i < this.n) { this.cards[i] = this.cards[this.n - 1]; this.cards[this.n - 1] = c; this.n--; } }
    restoreAll() { this.n = this.cards.length + 0; }
  }

  // ---------- Evaluators ----------
  // High 5-card value (bigger = better). wheel: whether A2345 is a straight. aceLow: A ranks as 1.
  function eval5High(cs, wheel) {
    const r = cs.map(rk).sort((a, b) => b - a);
    const flush = cs.every((c) => st(c) === st(cs[0]));
    const cnt = {}; r.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
    const groups = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a);
    const uniq = groups.length;
    let straightHi = -1;
    if (uniq === 5) {
      if (r[0] - r[4] === 4) straightHi = r[0];
      else if (wheel && r[0] === 12 && r[1] === 3) straightHi = 3;
    }
    let cat, ks;
    if (straightHi >= 0 && flush) { cat = 8; ks = [straightHi]; }
    else if (cnt[groups[0]] === 4) { cat = 7; ks = groups; }
    else if (cnt[groups[0]] === 3 && uniq === 2) { cat = 6; ks = groups; }
    else if (flush) { cat = 5; ks = r; }
    else if (straightHi >= 0) { cat = 4; ks = [straightHi]; }
    else if (cnt[groups[0]] === 3) { cat = 3; ks = groups; }
    else if (cnt[groups[0]] === 2 && uniq === 3) { cat = 2; ks = groups; }
    else if (uniq === 4) { cat = 1; ks = groups; }
    else { cat = 0; ks = r; }
    let v = cat; for (let i = 0; i < 5; i++) v = v * 13 + (ks[i] || 0); return v;
  }
  const COMB7 = []; (function () { for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) { const k = []; for (let i = 0; i < 7; i++) if (i !== a && i !== b) k.push(i); COMB7.push(k); } })();
  function best7High(cs) { let best = -1; for (const k of COMB7) { const v = eval5High(k.map((i) => cs[i]), true); if (v > best) best = v; } return best; }
  // 2-7 lowball: smaller = better (A high, straights & flushes count)
  const eval27 = (cs) => eval5High(cs, false);
  // A-5 low value of a set of ranks (A=0..K=12), pairs penalized, smaller = better
  function lowA5Value(lr) { // lr: 5 ranks with A=0
    const cnt = {}; lr.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
    const groups = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a);
    const pat = groups.map((g) => cnt[g]).join("");
    const cat = { "11111": 0, "2111": 1, "221": 2, "311": 3, "32": 4, "41": 5 }[pat];
    let v = cat; for (let i = 0; i < 5; i++) v = v * 13 + (groups[i] || 0); return v;
  }
  const aLow = (c) => (rk(c) + 1) % 13; // A->0, 2->1 ... K->12
  function best7Razz(cs) { // smaller = better
    const d = [...new Set(cs.map(aLow))].sort((a, b) => a - b);
    if (d.length >= 5) return lowA5Value(d.slice(0, 5));
    let best = Infinity; for (const k of COMB7) { const v = lowA5Value(k.map((i) => aLow(cs[i]))); if (v < best) best = v; } return best;
  }
  function best7Low8(cs) { // null if no qualifying low; smaller = better
    const d = [...new Set(cs.map(aLow))].filter((x) => x <= 7).sort((a, b) => a - b);
    if (d.length < 5) return null; return lowA5Value(d.slice(0, 5));
  }
  // Badugi: smaller = better. Uses A low.
  function badugiBest(cs) { // returns {size, ranks(desc, A=0), idx}
    let best = null;
    for (let m = 1; m < 1 << cs.length; m++) {
      const sub = []; for (let i = 0; i < cs.length; i++) if (m & (1 << i)) sub.push(i);
      const rs = new Set(), ss = new Set(); let ok = true;
      for (const i of sub) { const r = aLow(cs[i]), s = st(cs[i]); if (rs.has(r) || ss.has(s)) { ok = false; break; } rs.add(r); ss.add(s); }
      if (!ok) continue;
      const ranks = sub.map((i) => aLow(cs[i])).sort((a, b) => b - a);
      const cand = { size: sub.length, ranks, idx: sub };
      if (!best || badugiCmp(cand, best) < 0) best = cand;
    }
    return best;
  }
  function badugiCmp(a, b) { if (a.size !== b.size) return b.size - a.size; for (let i = 0; i < a.size; i++) if (a.ranks[i] !== b.ranks[i]) return a.ranks[i] - b.ranks[i]; return 0; }
  function badugiValue(cs) { const b = badugiBest(cs); let v = 4 - b.size; for (let i = 0; i < 4; i++) v = v * 13 + (b.ranks[i] != null ? b.ranks[i] : 0); return v; }

  // ---------- Draw strategies ----------
  const RV = (ch) => RANKS.indexOf(ch); // "9" -> 7
  const DEFAULT_PAT = {
    "27td": { 3: "9", 2: "9", 1: "T" },
    "27sd": { 1: "J" },
    badugi: { 3: "J", 2: "Q", 1: "K" },
  };
  // 2-7: returns indices to discard
  function strat27(hand, drawsLeft, opt) {
    const pat = (opt.pat || {})[drawsLeft] || DEFAULT_PAT[opt.game][drawsLeft] || "T";
    const keepMax = RV(opt.keepMax || "8");
    const v = eval27(hand), cat = Math.floor(v / 371293);
    const hi = Math.max(...hand.map(rk));
    if (cat === 0 && hi <= RV(pat)) return [];
    if (cat === 0 && opt.breakRule !== false && hi <= RV(pat) + 1 && drawsLeft === 1 && opt.patRough) return [];
    // keepers: distinct ranks 2..keepMax (no aces)
    const seen = new Set(); let keep = [];
    hand.map((c, i) => [c, i]).sort((a, b) => rk(a[0]) - rk(b[0])).forEach(([c, i]) => {
      if (rk(c) <= keepMax && !seen.has(rk(c))) { seen.add(rk(c)); keep.push(i); } });
    if (keep.length === 5) { // made but too rough, or straight/flush: break the top card
      keep.sort((a, b) => rk(hand[b]) - rk(hand[a])); keep = keep.slice(1); }
    if (keep.length === 4) { // avoid 4-flush and 4-straight-ish draws? keep simple: drop flush if 4 suited and there is an alternative
      const rs = keep.map((i) => rk(hand[i])).sort((a, b) => a - b);
      if (rs[3] - rs[0] === 3 && opt.avoidStraightDraw !== false) { /* e.g. 3456 — still a draw, keep */ }
    }
    const ks = new Set(keep); return hand.map((_, i) => i).filter((i) => !ks.has(i));
  }
  function stratBadugi(hand, drawsLeft, opt) {
    const pat = (opt.pat || {})[drawsLeft] || DEFAULT_PAT.badugi[drawsLeft] || "K";
    const keepMax = aLow(parseCard((opt.keepMax || "9") + "s"));
    const b = badugiBest(hand);
    const patV = aLow(parseCard(pat + "s"));
    if (b.size === 4 && b.ranks[0] <= patV) return [];
    let keep = b.idx.slice();
    if (b.size === 4) { // rough badugi: break the top card
      keep.sort((x, y) => aLow(hand[y]) - aLow(hand[x])); keep = keep.slice(1);
    } else if (drawsLeft > 1 || b.size < 3) {
      keep = keep.filter((i) => aLow(hand[i]) <= keepMax || keep.length === 1 && false);
    }
    const ks = new Set(keep); return hand.map((_, i) => i).filter((i) => !ks.has(i));
  }
  function stratFor(game) { return game === "badugi" ? stratBadugi : strat27; }
  const drawValue = (game, h) => (game === "badugi" ? badugiValue(h) : eval27(h));
  const handSize = (game) => (game === "badugi" ? 4 : 5);
  const totalDraws = (game) => (game === "27sd" ? 1 : 3);

  /* Draw-game equity.
     spec = { game, drawsLeft, dead:"", trials, seed,
       players:[ { hand:"7h5d4c3s2h" | "" (unknown),
                   discard:"Kd" (hero only: cards to throw this draw, optional),
                   history:[2,1] (unknown hands: cards drawn on each earlier draw),
                   pat:{3:"8",2:"9",1:"T"}, keepMax:"8" } ] } */
  function equityDraw(spec) {
    const game = spec.game, rand = rng(spec.seed), trials = spec.trials || 20000;
    const H = handSize(game), strat = stratFor(game);
    const total = totalDraws(game);
    const drawsLeft = spec.drawsLeft != null ? spec.drawsLeft : total;
    const dead = parseCards(spec.dead || "");
    const P = spec.players.map((p) => {
      const h = parseHand(p.hand || "");
      return { known: h.known, unknown: Math.max(0, H - h.known.length), opt: Object.assign({ game }, p),
        discard: p.discard != null ? parseCards(p.discard) : null, history: p.history || [] };
    });
    const allKnown = dead.concat(...P.map((p) => p.known));
    if (new Set(allKnown).size !== allKnown.length) throw new Error("Duplicate card");
    const wins = new Array(P.length).fill(0); let done = 0, tries = 0;
    const maxTries = trials * 400;
    while (done < trials && tries < maxTries) {
      tries++;
      const deck = new Deck(allKnown, rand);
      const hands = []; let reject = false;
      for (const p of P) {
        let h = p.known.slice();
        if (p.unknown) {
          if (p.history.length) { // rebuild from the start: random deal, then the earlier draws
            h = h.concat(Array.from({ length: p.unknown }, () => deck.draw()));
            let dl = total;
            for (const want of p.history) {
              const d = strat(h, dl, p.opt);
              if (want != null && d.length !== want) { reject = true; break; }
              const ds = new Set(d); const kept = h.filter((_, i) => !ds.has(i));
              d.forEach((i) => deck.muck.push(h[i]));
              h = kept.concat(Array.from({ length: d.length }, () => deck.draw())); dl--;
            }
            if (reject) break;
          } else h = h.concat(Array.from({ length: p.unknown }, () => deck.draw()));
        }
        hands.push(h);
      }
      if (reject) continue;
      // play remaining draws
      for (let dl = drawsLeft; dl >= 1; dl--) {
        for (let pi = 0; pi < P.length; pi++) {
          const h = hands[pi]; let d;
          if (dl === drawsLeft && P[pi].discard) { const set = new Set(P[pi].discard); d = h.map((c, i) => (set.has(c) ? i : -1)).filter((i) => i >= 0); }
          else d = strat(h, dl, P[pi].opt);
          if (!d.length) continue;
          const ds = new Set(d); const kept = h.filter((_, i) => !ds.has(i));
          d.forEach((i) => deck.muck.push(h[i]));
          hands[pi] = kept.concat(Array.from({ length: d.length }, () => deck.draw()));
        }
      }
      const vals = hands.map((h) => drawValue(game, h));
      const best = Math.min(...vals); const w = vals.filter((v) => v === best).length;
      vals.forEach((v, i) => { if (v === best) wins[i] += 1 / w; });
      done++;
    }
    return { trials: done, equity: wins.map((w) => w / Math.max(1, done)), acceptRate: done / tries };
  }

  /* Best draw for hero: tries every discard set and ranks them by equity. */
  function bestDraw(spec, heroIndex) {
    heroIndex = heroIndex || 0;
    const game = spec.game; const H = handSize(game);
    const hand = parseCards(spec.players[heroIndex].hand);
    if (hand.length !== H) throw new Error("Hero needs a full hand");
    const opts = [];
    for (let m = 0; m < 1 << H; m++) {
      const disc = hand.filter((_, i) => m & (1 << i));
      opts.push(disc);
    }
    const quick = Math.max(800, Math.floor((spec.trials || 20000) / 8));
    let scored = opts.map((d) => {
      const s = JSON.parse(JSON.stringify(spec)); s.trials = quick;
      s.players[heroIndex].discard = d.map(cardStr).join("");
      return { discard: d, eq: equityDraw(s).equity[heroIndex] };
    }).sort((a, b) => b.eq - a.eq);
    scored = scored.slice(0, 5).map((o) => {
      const s = JSON.parse(JSON.stringify(spec)); s.players[heroIndex].discard = o.discard.map(cardStr).join("");
      return { discard: o.discard.map(cardStr), keep: hand.filter((c) => !o.discard.includes(c)).map(cardStr), equity: equityDraw(s).equity[heroIndex] };
    }).sort((a, b) => b.equity - a.equity);
    return scored;
  }

  // ---------- Stud family ----------
  // Starting-hand categories for unknown hole cards (first 3 cards = 2 down + door)
  const STUD_CATS = {
    any: () => true,
    pair: (c3) => new Set(c3.map(rk)).size < 3,
    bigpair: (c3) => { const r = c3.map(rk); return (r[0] === r[1] && r[0] >= 8) || (r[0] === r[2] && r[0] >= 8) || (r[1] === r[2] && r[1] >= 8); },
    rolled: (c3) => new Set(c3.map(rk)).size === 1,
    "3flush": (c3) => new Set(c3.map(st)).size === 1,
    "3straight": (c3) => { const r = [...new Set(c3.map(rk))].sort((a, b) => a - b); return r.length === 3 && r[2] - r[0] <= 4; },
    "3low8": (c3) => { const r = new Set(c3.map(aLow)); return r.size === 3 && [...r].every((x) => x <= 7); },
    "3low7": (c3) => { const r = new Set(c3.map(aLow)); return r.size === 3 && [...r].every((x) => x <= 6); },
    "3low6": (c3) => { const r = new Set(c3.map(aLow)); return r.size === 3 && [...r].every((x) => x <= 5); },
    "2low+ace": (c3) => c3.some((c) => rk(c) === 12) && new Set(c3.map(aLow)).size === 3,
  };
  /* spec = { game:"stud"|"stud8"|"razz", dead:"Kc 9d ...", trials, seed,
       players:[ { down:"AsAd" | "xx", up:"Kh 7c", range:["pair","3flush"] } ] }
     Unknown downs ("x") are dealt at random; range (OR of STUD_CATS) is applied to
     the first three cards when any of them is unknown. */
  function equityStud(spec) {
    const game = spec.game, rand = rng(spec.seed), trials = spec.trials || 20000;
    const dead = parseCards(spec.dead || "");
    const P = spec.players.map((p) => {
      const d = parseHand(p.down || ""), u = parseCards(p.up || "");
      const downSlots = []; // order: first two downs, then up cards, 7th down
      return { down: d.known, downUnknown: d.unknown, up: u, range: p.range && p.range.length ? p.range : null };
    });
    const known = dead.concat(...P.map((p) => p.down.concat(p.up)));
    if (new Set(known).size !== known.length) throw new Error("Duplicate card");
    const n = P.length;
    const wins = new Array(n).fill(0), scoops = new Array(n).fill(0); let done = 0, tries = 0;
    while (done < trials && tries < trials * 300) {
      tries++;
      const deck = new Deck(known, rand);
      const hands = []; let reject = false;
      for (const p of P) {
        // first 3 cards: up to 2 down + door
        const first = p.down.slice(0, 2);
        let unkFirst = 0;
        while (first.length < 2) { first.push(deck.draw()); unkFirst++; }
        const door = p.up.length ? p.up[0] : (unkFirst++, deck.draw());
        if (p.range && unkFirst > 0) {
          const c3 = [first[0], first[1], door];
          if (!p.range.some((k) => STUD_CATS[k] && STUD_CATS[k](c3))) { reject = true; break; }
        }
        hands.push({ cards: [first[0], first[1], door].concat(p.up.slice(1)), seventh: p.down.length > 2 ? p.down[2] : null });
      }
      if (reject) continue;
      // deal up to 7 cards each; community river if deck short
      let comm = null;
      try {
        for (const h of hands) { while (h.cards.length < 6) h.cards.push(deck.draw()); }
        const needed = hands.filter((h) => h.seventh == null).length;
        if (deck.n < needed) comm = deck.draw();
        for (const h of hands) h.cards.push(h.seventh != null ? h.seventh : (comm != null ? comm : deck.draw()));
      } catch (e) { continue; }
      const score = (h) => h.cards;
      if (game === "stud") {
        const v = hands.map((h) => best7High(h.cards)); const b = Math.max(...v); const w = v.filter((x) => x === b).length;
        v.forEach((x, i) => { if (x === b) { wins[i] += 1 / w; if (w === 1) scoops[i]++; } });
      } else if (game === "razz") {
        const v = hands.map((h) => best7Razz(h.cards)); const b = Math.min(...v); const w = v.filter((x) => x === b).length;
        v.forEach((x, i) => { if (x === b) { wins[i] += 1 / w; if (w === 1) scoops[i]++; } });
      } else { // stud8
        const hv = hands.map((h) => best7High(h.cards)); const hb = Math.max(...hv);
        const hiW = hv.map((x) => x === hb); const hiN = hiW.filter(Boolean).length;
        const lv = hands.map((h) => best7Low8(h.cards)); const ql = lv.filter((x) => x != null);
        if (!ql.length) hiW.forEach((w, i) => { if (w) { wins[i] += 1 / hiN; if (hiN === 1) scoops[i]++; } });
        else {
          const lb = Math.min(...ql); const loW = lv.map((x) => x === lb); const loN = loW.filter(Boolean).length;
          for (let i = 0; i < n; i++) { let s = 0; if (hiW[i]) s += 0.5 / hiN; if (loW[i]) s += 0.5 / loN; wins[i] += s;
            if (hiW[i] && loW[i] && hiN === 1 && loN === 1) scoops[i]++; }
        }
      }
      done++;
    }
    return { trials: done, equity: wins.map((w) => w / Math.max(1, done)), scoop: scoops.map((s) => s / Math.max(1, done)), acceptRate: done / tries };
  }

  /* Stud street-by-street report: hero's full hand + opponents' up cards by street.
     streets: array of {hero:{down,up}, opps:[{down,up,range}]} snapshots, or use equityStud per street. */
  function studReport(game, snapshots, opts) {
    return snapshots.map((s, i) => ({ street: s.label || (3 + i) + "th", ...equityStud(Object.assign({ game, trials: (opts && opts.trials) || 8000 }, s)) }));
  }

  const MixEq = { RANKS, SUITS, parseCard, cardStr, parseHand, parseCards,
    eval5High, best7High, eval27, best7Razz, best7Low8, badugiBest, badugiValue,
    strat27, stratBadugi, DEFAULT_PAT, STUD_CATS, equityDraw, bestDraw, equityStud, studReport, rng };
  if (typeof module !== "undefined" && module.exports) module.exports = MixEq; else root.MixEq = MixEq;
})(typeof window !== "undefined" ? window : globalThis);
/* MixEq equity panel: floating button + drawer. Needs MixEq loaded first.
   Set window.MIXEQ_GAMES = ["27td","badugi"] before loading to limit the game list. */
(function () {
  "use strict";
  const M = window.MixEq; if (!M) return;
  const NAMES = { "27td": "2-7 Triple Draw", "27sd": "2-7 Single Draw", badugi: "Badugi", stud: "Stud", stud8: "Stud 8", razz: "Razz" };
  const games = (window.MIXEQ_GAMES || Object.keys(NAMES)).filter((g) => NAMES[g]);
  const isDraw = (g) => g === "27td" || g === "27sd" || g === "badugi";
  const css = `
  #mxq-btn{position:fixed;right:0;top:40%;writing-mode:vertical-rl;z-index:9998;border:0;border-radius:10px 0 0 10px;padding:16px 10px;font:600 14px system-ui,sans-serif;background:#18192b;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}
  #mxq{position:fixed;inset:auto 0 0 auto;top:0;width:min(460px,100vw);z-index:9999;background:var(--surface,#fff);color:var(--ink,#18192b);border-left:1px solid var(--line,#d6d8e2);box-shadow:-8px 0 30px rgba(0,0,0,.18);display:flex;flex-direction:column;font:14px/1.45 system-ui,sans-serif;padding-top:env(safe-area-inset-top,0px)}
  #mxq[hidden]{display:none!important}
  #mxq header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line,#d6d8e2)}
  #mxq header b{font-size:16px}
  #mxq .body{overflow:auto;padding:14px 16px 28px;display:flex;flex-direction:column;gap:12px}
  #mxq label{font-size:12px;color:var(--muted,#5c6178);display:flex;flex-direction:column;gap:3px}
  #mxq input,#mxq select{font:14px ui-monospace,Consolas,monospace;padding:7px 8px;border:1px solid var(--line,#d6d8e2);border-radius:8px;background:var(--bg,#f6f6f9);color:inherit;min-width:0}
  #mxq .row{display:grid;gap:8px;grid-template-columns:1fr 1fr}
  #mxq .pl{border:1px solid var(--line,#d6d8e2);border-radius:10px;padding:10px;display:grid;gap:8px;grid-template-columns:1fr 1fr}
  #mxq .pl .t{grid-column:1/-1;display:flex;justify-content:space-between;font-weight:600;font-size:13px}
  #mxq button.b{border:1px solid var(--line,#d6d8e2);background:var(--bg,#f6f6f9);color:inherit;border-radius:8px;padding:8px 12px;font:600 13px system-ui,sans-serif;cursor:pointer}
  #mxq button.p{background:var(--accent,#4a3fa8);color:var(--accent-ink,#fff);border-color:transparent}
  #mxq button.x{border:0;background:none;color:inherit;font-size:20px;cursor:pointer;padding:0 4px}
  #mxq .acts{display:flex;gap:8px;flex-wrap:wrap}
  #mxq table{width:100%;border-collapse:collapse;font-size:13px}
  #mxq td,#mxq th{padding:6px 4px;border-bottom:1px solid var(--line,#d6d8e2);text-align:left}
  #mxq td.n{text-align:right;font-family:ui-monospace,Consolas,monospace}
  #mxq .bar{height:6px;border-radius:3px;background:var(--accent,#4a3fa8)}
  #mxq .note{font-size:12px;color:var(--muted,#5c6178)}
  #mxq .err{color:var(--bad,#b0261d);font-size:13px}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const btn = document.createElement("button"); btn.id = "mxq-btn"; btn.type = "button"; btn.textContent = "Equity";
  const box = document.createElement("aside"); box.id = "mxq"; box.hidden = true; box.setAttribute("aria-label", "Equity calculator");
  box.innerHTML = `<header><b>Equity calculator</b><button class="x" type="button" aria-label="Close">×</button></header>
  <div class="body">
    <div class="row"><label>Game<select id="mxq-g">${games.map((g) => `<option value="${g}">${NAMES[g]}</option>`).join("")}</select></label>
      <label id="mxq-dlw">Draws left<select id="mxq-dl"><option>3</option><option>2</option><option>1</option><option>0</option></select></label></div>
    <div id="mxq-pl" style="display:flex;flex-direction:column;gap:8px"></div>
    <div class="acts"><button class="b" type="button" id="mxq-add">+ Player</button></div>
    <label>Dead / folded / seen cards<input id="mxq-dead" placeholder="e.g. Kc 9d 4h" autocomplete="off"></label>
    <label>Trials<select id="mxq-n"><option value="5000">5,000 (fast)</option><option value="20000" selected>20,000</option><option value="60000">60,000 (precise)</option></select></label>
    <div class="acts"><button class="b p" type="button" id="mxq-run">Run equity</button><button class="b" type="button" id="mxq-best">Best draw for Player 1</button></div>
    <div id="mxq-out"></div>
    <p class="note" id="mxq-help"></p>
  </div>`;
  document.body.appendChild(btn); document.body.appendChild(box);
  const $ = (s) => box.querySelector(s);
  btn.onclick = () => { box.hidden = !box.hidden; };
  box.querySelector("header .x").onclick = () => { box.hidden = true; };
  let n = 2;
  function playerHtml(i, g) {
    const t = `<div class="t"><span>Player ${i + 1}${i === 0 ? " (you)" : ""}</span>${i > 1 ? `<button class="x" type="button" data-rm="${i}" aria-label="Remove">×</button>` : ""}</div>`;
    if (isDraw(g)) return t + `<label>Hand${i ? " (blank = unknown)" : ""}<input data-k="hand" placeholder="${g === "badugi" ? "As2d3c" + "Kc" : "2s3d4c7hKs"}" autocomplete="off"></label>
      <label>Drew so far${i ? "" : " (unknown only)"}<input data-k="history" placeholder="e.g. 2,1" autocomplete="off"></label>
      <label>Pats at or better<input data-k="pat" placeholder="${(M.DEFAULT_PAT[g] && M.DEFAULT_PAT[g][3] || "J")} default" autocomplete="off"></label>
      <label>Keeps cards up to<input data-k="keepMax" placeholder="${g === "badugi" ? "9" : "8"}" autocomplete="off"></label>`;
    return t + `<label>Down cards<input data-k="down" placeholder="${i ? "xx" : "AsAd"}" autocomplete="off"></label>
      <label>Up cards<input data-k="up" placeholder="Kh 7c" autocomplete="off"></label>
      <label style="grid-column:1/-1">Range for unknown downs<select data-k="range"><option value="">Any</option>${Object.keys(M.STUD_CATS).filter((k) => k !== "any").map((k) => `<option>${k}</option>`).join("")}</select></label>`;
  }
  function render() {
    const g = $("#mxq-g").value;
    $("#mxq-dlw").style.display = isDraw(g) ? "" : "none";
    $("#mxq-best").style.display = isDraw(g) ? "" : "none";
    if (g === "27sd") { $("#mxq-dl").value = "1"; }
    $("#mxq-pl").innerHTML = Array.from({ length: n }, (_, i) => `<div class="pl" data-i="${i}">${playerHtml(i, g)}</div>`).join("");
    $("#mxq-help").textContent = isDraw(g)
      ? "Showdown equity if nobody folds. Unknown hands are dealt at random and filtered by what they drew so far; every future draw follows the pat/keep rules (tune them per player from your scouting reads)."
      : "Showdown equity if everyone goes to 7th street. Use x for unknown down cards; the range filters the first three cards. Folded up cards go in dead cards.";
    $("#mxq-out").innerHTML = "";
  }
  $("#mxq-g").onchange = render;
  $("#mxq-add").onclick = () => { if (n < 6) { n++; render(); } };
  box.addEventListener("click", (e) => { const r = e.target.closest("[data-rm]"); if (r) { n--; render(); } });
  function readSpec() {
    const g = $("#mxq-g").value;
    const players = [...box.querySelectorAll(".pl")].map((el) => {
      const o = {}; el.querySelectorAll("[data-k]").forEach((f) => { o[f.dataset.k] = f.value.trim(); }); return o; });
    const spec = { game: g, dead: $("#mxq-dead").value, trials: +$("#mxq-n").value };
    if (isDraw(g)) {
      const dl = +$("#mxq-dl").value; spec.drawsLeft = Math.min(dl, g === "27sd" ? 1 : 3);
      spec.players = players.map((p) => {
        const o = { hand: p.hand };
        if (!p.hand.replace(/[\sx?]/gi, "") && p.history) o.history = p.history.split(/[,\s]+/).filter(Boolean).map(Number);
        if (p.pat) o.pat = { 3: p.pat.toUpperCase(), 2: p.pat.toUpperCase(), 1: p.pat.toUpperCase() };
        if (p.keepMax) o.keepMax = p.keepMax.toUpperCase();
        return o; });
    } else {
      spec.players = players.map((p) => ({ down: p.down || "xx", up: p.up, range: p.range ? [p.range] : null }));
    }
    return spec;
  }
  const pct = (x) => (x * 100).toFixed(1) + "%";
  function run(best) {
    const out = $("#mxq-out"); out.innerHTML = `<p class="note">Running…</p>`;
    setTimeout(() => {
      try {
        const spec = readSpec();
        if (best) {
          const r = M.bestDraw(spec, 0);
          out.innerHTML = `<table><tr><th>Keep</th><th>Throw</th><th class="n">Equity</th></tr>${r.map((o, i) => `<tr><td>${o.keep.join(" ") || "—"}</td><td>${o.discard.join(" ") || "pat"}</td><td class="n">${i === 0 ? "<b>" + pct(o.equity) + "</b>" : pct(o.equity)}</td></tr>`).join("")}</table>
          <p class="note">Top 5 of every keep option for Player 1 on this draw. Later draws follow the rules.</p>`;
          return;
        }
        const r = isDraw(spec.game) ? M.equityDraw(spec) : M.equityStud(spec);
        if (!r.trials) throw new Error("No deals matched these players. Loosen a range or draw history.");
        out.innerHTML = `<table><tr><th>Player</th><th class="n">Equity</th>${r.scoop ? '<th class="n">Scoop</th>' : ""}<th style="width:35%"></th></tr>${r.equity.map((e, i) => `<tr><td>Player ${i + 1}</td><td class="n">${pct(e)}</td>${r.scoop ? `<td class="n">${pct(r.scoop[i])}</td>` : ""}<td><div class="bar" style="width:${(e * 100).toFixed(1)}%"></div></td></tr>`).join("")}</table>
        <p class="note">${r.trials.toLocaleString()} deals${r.acceptRate < 1 ? `, ${(r.acceptRate * 100).toFixed(0)}% matched the ranges/draw history` : ""}. Margin about ±${(100 / Math.sqrt(r.trials)).toFixed(1)} pts.</p>`;
      } catch (e) { out.innerHTML = `<p class="err">${String(e.message || e)}</p>`; }
    }, 20);
  }
  $("#mxq-run").onclick = () => run(false);
  $("#mxq-best").onclick = () => run(true);
  window.MixEqPanel = { open(game, players) { box.hidden = false; if (game && games.includes(game)) { $("#mxq-g").value = game; } n = Math.max(2, (players && players.length) || n); render();
      if (players) players.forEach((p, i) => { const el = box.querySelectorAll(".pl")[i]; if (!el) return; Object.entries(p).forEach(([k, v]) => { const f = el.querySelector(`[data-k="${k}"]`); if (f) f.value = v; }); }); } };
  render();
})();
