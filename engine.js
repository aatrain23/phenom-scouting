/* Phenom hand-history engine: parses Phenom Poker cash and tournament hand histories, counts each
   player's actions per game, and turns the counts into scouting cards (stats, z-scored reads, style).
   Runs in the page (window.PhenomEngine) and in Node (module.exports) so the shipped base data and
   in-page uploads are counted the same way. */
(function (root) {
  'use strict';
  const FIELDS = ['hands','vpip','pfr','open_opp','open_raise','open_limp','steal_opp','steal','face_open','threebet','cold_call',
    'vs_steal','fold_steal','bi_vs_complete','bi_fold','saw_post','wtsd','wsd','xr','xr_opp',
    'r1_face_bet','r1_fold_bet','r2_face_bet','r2_fold_bet','r3_face_bet','r3_fold_bet','r4_face_bet','r4_fold_bet',
    'd1_n','d1_pat','fewer_opp','fewer_bet','more_opp','more_lead','vs_pat_river_bet','fold_pat_river_bet',
    'rbet_sd','rbet_sd_weak','rcall_sd','rcall_sd_weak','pat_final_sd','snow_sd'];
  const FI = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  const GAMEMAP = {'2-7 Triple Draw':'27TD','A-5 Triple Draw':'A5TD','Badugi':'Badugi','Badeucy':'Badeucy','Omaha Hi/Lo':'O8','7 Card Stud Hi/Lo':'Stud8','2-7 Razz':'27Razz'};
  const DRAW4 = new Set(['27TD','A5TD','Badugi','Badeucy']);
  const R27 = {}; '23456789TJQKA'.split('').forEach((r, i) => R27[r] = i + 2);
  const R5 = {A: 1}; '23456789TJQK'.split('').forEach((r, i) => R5[r] = i + 2);
  const num = s => parseFloat(String(s).replace(/[$,]/g, ''));
  const AMT = /\$?(\d[\d.,]*)/;

  function parse(text) {
    const out = [];
    for (let block of text.split(/\r?\n\r?\n\r?\n/)) {
      block = block.replace(/^\s+|\s+$/g, '');
      if (!block.startsWith('Phenom Poker Hand')) continue;
      const lines = block.split(/\r?\n/);
      let m = lines[0].match(/^Phenom Poker Hand #(\w+): (.+?) \(\$([\d.,]+)\/\$([\d.,]+) USD\) - (\S+) (\S+)/);
      let id, gfull, s2, date, tourney = null;
      if (m) { id = m[1]; gfull = m[2]; s2 = m[4]; date = m[5]; }
      else {
        m = lines[0].match(/^Phenom Poker Hand #(\w+): Tournament #([\w-]+), (.+?) - Level (\d+) \(([\d.,]+)\/([\d.,]+)\) - (\S+) (\S+)/);
        if (!m) continue;
        id = m[1]; tourney = m[2]; gfull = m[3].replace('Triple Draw 2-7 Lowball', '2-7 Triple Draw'); s2 = m[6]; date = m[7];
        if (num(s2) === 0) continue;
      }
      const gname = gfull.replace(/ Limit$/, '');
      const game = GAMEMAP[gname] || gname;
      const fam = block.includes('*** 3rd STREET ***') ? 'stud' : (block.includes('*** HOLE CARDS ***') ? 'flop' : 'draw');
      const final = fam === 'stud' ? 4 : (gname.includes('Single Draw') ? 1 : (gname.includes('Double Draw') ? 2 : 3));
      const h = {id, tourney, game, fam, final, date: date.replace(/\//g, '-'), players: [], chips: {}, actions: [], showdown: {}, desc: {},
        contrib: {}, collected: {}, rake: 0, sbp: null, bbp: null, bringin: null, hero: null};
      let street = -1, sb = {}, insum = false;
      const add = (o, p, v) => { o[p] = (o[p] || 0) + v; };
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        const sm = l.match(/^\*\*\* (.+?) \*\*\*/);
        if (sm) {
          const nm = sm[1];
          if (nm === 'SUMMARY') { insum = true; continue; }
          if (/SHOW DOWN$/.test(nm)) continue;
          const second = nm.startsWith('SECOND ') && nm !== 'SECOND DRAW';
          const base = nm.startsWith('FIRST ') && nm !== 'FIRST DRAW' ? nm.slice(6) : (second ? nm.slice(7) : nm);
          const order = fam === 'stud' ? ['3rd STREET','4th STREET','5th STREET','6th STREET','RIVER'] : fam === 'flop' ? ['HOLE CARDS','FLOP','TURN','RIVER'] : ['DEALING HANDS','FIRST DRAW','SECOND DRAW','THIRD DRAW'];
          const ix = order.indexOf(base);
          if (ix < 0) continue;
          street = ix;
          if (street > 0 && !second) sb = {};
          continue;
        }
        if (insum) {
          const mt = l.match(/^Total pot \$?([\d.,]+)(?: \| Rake \$?([\d.,]+))?/);
          if (mt) { h.rake = mt[2] ? num(mt[2]) : 0; continue; }
          const md = l.match(/^Seat \d+: (.+?) (?:\(.*?\) )?showed \[(.*?)\] and (won|lost)(?: \([\d.,$]+\))? with (.*)$/);
          if (md) h.desc[md[1]] = md[4];
          continue;
        }
        let mm;
        if (street === -1 && (mm = l.match(/^Seat (\d+): (.+?) \(\$?([\d.,]+) in chips\)/))) { h.players.push([+mm[1], mm[2]]); h.chips[mm[2]] = num(mm[3]); continue; }
        if ((mm = l.match(/^Dealt to (.+?) \[(.*?)\]/))) { if (!h.hero && mm[2].split(' ').length >= 2 && h.chips[mm[1]] !== undefined) h.hero = mm[1]; continue; }
        if ((mm = l.match(/^Uncalled bet \(\$?([\d.,]+)\) returned to (.+)$/))) { add(h.contrib, mm[2], -num(mm[1])); continue; }
        if ((mm = l.match(/^(.+?) collected \$?([\d.,]+) from pot/))) { add(h.collected, mm[1], num(mm[2])); continue; }
        mm = l.match(/^(.+?): (.*)$/);
        if (!mm || h.chips[mm[1]] === undefined) continue;
        const p = mm[1], a = mm[2], st = Math.max(street, 0);
        const amt = s => num(s.match(AMT)[1]);
        if (a.startsWith('posts the ante')) { add(h.contrib, p, amt(a.slice(14))); continue; }
        if (a.startsWith('posts small blind')) { const v = amt(a.slice(17)); add(h.contrib, p, v); add(sb, p, v); h.sbp = p; continue; }
        if (a.startsWith('posts big blind')) { const v = amt(a.slice(15)); add(h.contrib, p, v); add(sb, p, v); h.bbp = p; continue; }
        if (a.startsWith('posts')) { const v = amt(a.replace(/^posts \D*/, '')); add(h.contrib, p, v); add(sb, p, v); continue; }
        if (a.startsWith('brings in for')) { const v = amt(a.slice(13)); add(h.contrib, p, v); add(sb, p, v); h.bringin = p; h.actions.push([st, p, 'bringin', v]); continue; }
        if (a === 'folds') { h.actions.push([st, p, 'fold', 0]); continue; }
        if (a === 'checks') { h.actions.push([st, p, 'check', 0]); continue; }
        if (a.startsWith('calls')) { const v = amt(a); add(h.contrib, p, v); add(sb, p, v); h.actions.push([st, p, 'call', v]); continue; }
        if (a.startsWith('bets')) { const v = amt(a); add(h.contrib, p, v); add(sb, p, v); h.actions.push([st, p, 'bet', v]); continue; }
        if (a.startsWith('raises')) { const to = num(a.match(/to \$?([\d.,]+)/)[1]); add(h.contrib, p, to - (sb[p] || 0)); sb[p] = to; h.actions.push([st, p, 'raise', to]); continue; }
        if (a.startsWith('discards')) { h.actions.push([st, p, 'draw', parseInt(a.match(/discards (\d+)/)[1], 10)]); continue; }
        if (a.startsWith('stands pat')) { h.actions.push([st, p, 'draw', 0]); continue; }
        if (a.startsWith('shows')) { const c = a.match(/\[(.*?)\]/); if (c) h.showdown[p] = c[1]; continue; }
      }
      h.players.sort((x, y) => x[0] - y[0]); h.players = h.players.map(x => x[1]);
      const pot = Object.values(h.contrib).reduce((s, v) => s + v, 0) - h.rake;
      const cs = Object.values(h.collected).reduce((s, v) => s + v, 0);
      h.net = {};
      h.players.forEach(p => { h.net[p] = (cs ? pot * (h.collected[p] || 0) / cs : 0) - (h.contrib[p] || 0); });
      h.netok = cs > 0;
      out.push(h);
    }
    return out;
  }

  const cardsOf = s => s.split(' ').filter(c => c.length === 2);
  function eval27(cs) { const r = cs.map(c => R27[c[0]]).sort((a, b) => b - a); const paired = new Set(r).size < 5; const flush = new Set(cs.map(c => c[1])).size === 1; const straight = !paired && r[0] - r[4] === 4; return {top: r[0], made: !(paired || flush || straight)}; }
  function evalA5(cs) { const r = cs.map(c => R5[c[0]]).sort((a, b) => b - a); return {top: r[0], made: new Set(r).size === 5}; }
  function badugi(desc) { const m = desc.match(/Badugi: a (\d)-card ([\w,]+)/) || desc.match(/^a (\d)-card ([\w,]+)/); return m ? [parseInt(m[1], 10), R5[m[2].split(',')[0]]] : [null, null]; }
  function handClass(h, p) {
    const sd = h.showdown[p]; if (!sd) return null; const cs = cardsOf(sd); const g = h.game;
    if (g === '27TD' && cs.length === 5) { const e = eval27(cs); if (!e.made || e.top >= 11) return 'weak'; return e.top <= 8 ? 'strong' : 'medium'; }
    if (g === 'A5TD' && cs.length === 5) { const e = evalA5(cs); if (!e.made || e.top >= 10) return 'weak'; return e.top <= 7 ? 'strong' : 'medium'; }
    if (g === 'Badugi') { const [n, top] = badugi(h.desc[p] || ''); if (n === null) return null; if (n < 4) return 'weak'; return top <= 9 ? 'strong' : 'medium'; }
    if (g === 'Badeucy') {
      const [n, top] = badugi(h.desc[p] || ''); const e = cs.length === 5 ? eval27(cs) : null;
      const goodLo = e && e.made && e.top <= 9, goodBd = n === 4 && top <= 9;
      if (goodLo && goodBd) return 'strong';
      if (goodLo || goodBd || n === 4 || (e && e.made && e.top <= 10)) return 'medium';
      return 'weak';
    }
    return null;
  }
  function positions(h) {
    const order = h.players; const i = order.indexOf(h.bbp); if (i < 0) return {};
    const act = order.slice(i + 1).concat(order.slice(0, i + 1)); const lab = {};
    if (act.length === 2) { lab[act[0]] = 'SB'; lab[act[1]] = 'BB'; return lab; }
    lab[act[act.length - 1]] = 'BB'; if (h.sbp && act.includes(h.sbp)) lab[h.sbp] = 'SB';
    const rest = act.filter(p => !(p in lab)).reverse(); const names = ['BTN','CO','HJ','LJ','UTG','UTG'];
    rest.forEach((p, k) => { lab[p] = names[Math.min(k, 5)]; }); return lab;
  }

  /* Count one hand into acc ({counts: {key: [..FIELDS]}, last: {fmt|player: date}}); skip players in `skip`. */
  function count(h, acc, skip) {
    const fmt = h.tourney ? 'T' : 'C', g = h.game;
    const mon = h.date.slice(0, 7); const C = p => { if (skip(p)) return null; const k = fmt + '|' + p + '|' + g + '|' + mon; return acc.counts[k] || (acc.counts[k] = new Array(FIELDS.length).fill(0)); };
    const inc = (p, f) => { const c = C(p); if (c) c[FI[f]] += 1; };
    const acts = h.actions, pls = h.players, pos = h.fam !== 'stud' ? positions(h) : {};
    pls.forEach(p => { if (!skip(p)) { inc(p, 'hands'); const lk = fmt + '|' + p; if (!acc.last[lk] || acc.last[lk] < h.date) acc.last[lk] = h.date; } });
    let raises = 0, limpers = 0, opener = null; const acted = new Set(), vpip = new Set(), pfr = new Set();
    for (const [st, p, a] of acts) {
      if (st !== 0) continue;
      if (!acted.has(p)) {
        acted.add(p);
        if (a !== 'bringin') {
          if (raises === 0 && limpers === 0) {
            if (a !== 'check' && p !== h.bringin) {
              inc(p, 'open_opp'); if (a === 'raise') inc(p, 'open_raise'); else if (a === 'call') inc(p, 'open_limp');
              if (['CO','BTN','SB'].includes(pos[p])) { inc(p, 'steal_opp'); if (a === 'raise') inc(p, 'steal'); }
            }
          } else if (raises === 1) {
            inc(p, 'face_open'); if (a === 'raise') inc(p, 'threebet'); else if (a === 'call') inc(p, 'cold_call');
            if (['CO','BTN','SB'].includes(pos[opener]) && ['SB','BB'].includes(pos[p]) && limpers === 0) { inc(p, 'vs_steal'); if (a === 'fold') inc(p, 'fold_steal'); }
          }
        }
      } else if (h.fam === 'stud' && p === h.bringin && raises === 1 && ['fold','call','raise'].includes(a)) {
        inc(p, 'bi_vs_complete'); if (a === 'fold') inc(p, 'bi_fold');
      }
      if (a === 'call' || a === 'raise') vpip.add(p);
      if (a === 'raise') { pfr.add(p); raises += 1; if (raises === 1) opener = p; }
      if (a === 'call' && raises === 0 && p !== h.sbp) limpers += 1;
    }
    pls.forEach(p => { if (vpip.has(p)) inc(p, 'vpip'); if (pfr.has(p)) inc(p, 'pfr'); });
    const sawpost = new Set(acts.filter(x => x[0] >= 1).map(x => x[1]));
    const sd = new Set([...Object.keys(h.showdown), ...Object.keys(h.desc)]);
    sawpost.forEach(p => { inc(p, 'saw_post'); if (sd.has(p)) { inc(p, 'wtsd'); if (h.netok && h.net[p] > 0) inc(p, 'wsd'); } });
    const draws = {}; acts.forEach(([st, p, a, v]) => { if (a === 'draw') (draws[st] = draws[st] || {})[p] = v; });
    for (let st = 1; st <= h.final; st++) {
      let open = false; const checked = new Set();
      for (const [s, p, a] of acts) {
        if (s !== st || a === 'draw') continue;
        if (open && st <= 4) { inc(p, 'r' + st + '_face_bet'); if (a === 'fold') inc(p, 'r' + st + '_fold_bet'); if (a === 'raise' && checked.has(p)) inc(p, 'xr'); if (checked.has(p)) inc(p, 'xr_opp'); }
        if (!open && a === 'check') checked.add(p);
        if (a === 'bet' || a === 'raise') open = true;
      }
    }
    if (DRAW4.has(g)) {
      const d1 = draws[1] || {}; Object.entries(d1).forEach(([p, n]) => { inc(p, 'd1_n'); if (n === 0) inc(p, 'd1_pat'); });
      for (const st of [1, 2, 3]) {
        const d = draws[st] || {}; const ks = Object.keys(d); if (ks.length !== 2) continue;
        let unbet = true;
        for (const [s, p, a] of acts) {
          if (s !== st || !['bet','check','raise','call','fold'].includes(a)) continue;
          if (!unbet) break;
          const me = d[p], op = d[ks[0] === p ? ks[1] : ks[0]];
          if (me === undefined || op === undefined) continue;
          if (me < op) { inc(p, 'fewer_opp'); if (a === 'bet') inc(p, 'fewer_bet'); } else if (me > op) { inc(p, 'more_opp'); if (a === 'bet') inc(p, 'more_lead'); }
          if (a === 'bet') unbet = false;
        }
      }
      const d3 = draws[3] || {}; let bettor = null;
      for (const [s, p, a] of acts) {
        if (s !== 3 || a === 'draw') continue;
        if (a === 'bet' && bettor === null) { bettor = p; continue; }
        if (bettor && p !== bettor && d3[bettor] === 0 && (d3[p] || 0) > 0 && ['fold','call','raise'].includes(a)) { inc(p, 'vs_pat_river_bet'); if (a === 'fold') inc(p, 'fold_pat_river_bet'); }
      }
      Object.keys(h.showdown).forEach(p => {
        const cls = handClass(h, p); if (!cls) return;
        const aggr = acts.some(x => x[0] === 3 && x[1] === p && (x[2] === 'bet' || x[2] === 'raise'));
        const call = acts.some(x => x[0] === 3 && x[1] === p && x[2] === 'call');
        if (aggr) { inc(p, 'rbet_sd'); if (cls === 'weak') inc(p, 'rbet_sd_weak'); }
        if ((draws[3] || {})[p] === 0) { inc(p, 'pat_final_sd'); if (cls === 'weak') inc(p, 'snow_sd'); }
        if (call && !aggr) { inc(p, 'rcall_sd'); if (cls === 'weak') inc(p, 'rcall_sd_weak'); }
      });
    }
  }
  function merge(into, src) {
    for (const [k, v] of Object.entries(src.counts)) { let t = into.counts[k]; if (!t) t = into.counts[k] = new Array(FIELDS.length).fill(0); for (let i = 0; i < v.length && i < FIELDS.length; i++) t[i] += Number(v[i]) || 0; }
    for (const [k, d] of Object.entries(src.last)) if (!into.last[k] || into.last[k] < d) into.last[k] = d;
    return into;
  }

  /* Collapse month-bucketed counts (fmt|player|game|YYYY-MM) into per-game counts. Each month is weighted by
     0.5 ^ (months before the newest month / halfLife); halfLife = Infinity weighs every hand the same.
     Returns {counts: weighted, raw: unweighted, last}. Keys without a month count at full weight. */
  function collapse(acc, halfLife) {
    let newest = '0000-00';
    for (const k of Object.keys(acc.counts)) { const m = k.slice(k.lastIndexOf('|') + 1); if (/^\d{4}-\d{2}$/.test(m) && m > newest) newest = m; }
    const ny = +newest.slice(0, 4), nm = +newest.slice(5, 7);
    const counts = {}, raw = {}, wcache = {};
    for (const [k, v] of Object.entries(acc.counts)) {
      const cut = k.lastIndexOf('|'); const m = k.slice(cut + 1); const hasM = /^\d{4}-\d{2}$/.test(m); const base = hasM ? k.slice(0, cut) : k;
      let w = 1;
      if (hasM && isFinite(halfLife)) { w = wcache[m]; if (w === undefined) { const age = (ny - +m.slice(0, 4)) * 12 + (nm - +m.slice(5, 7)); w = wcache[m] = Math.pow(0.5, Math.max(0, age) / halfLife); } }
      let c = counts[base], r = raw[base];
      if (!c) { c = counts[base] = new Array(FIELDS.length).fill(0); r = raw[base] = new Array(FIELDS.length).fill(0); }
      for (let i = 0; i < FIELDS.length; i++) { const x = v[i] || 0; if (x) { c[i] += x * w; r[i] += x; } }
    }
    return {counts, raw, last: acc.last, newest};
  }

  /* ---------- cards ---------- */
  const BLIND = ['27TD','A5TD','Badugi','Badeucy','O8','Badacey','2-7 Single Draw No',"Hold'em","Hold'em No",'Omaha Pot','Dramaha 2-7','Dramaha High','5 Card Omaha Hi/Lo Pot','FLO/DB'];
  const DR = ['27TD','A5TD','Badugi','Badeucy'];
  const STUDG = ['Stud8','27Razz','7 Card Stud','Razz','7 Card Stud Hi/Lo Regular'];
  const FAMS = {DRAW: DR, TD: ['27TD','A5TD'], ALLBLIND: BLIND, STUD: STUDG, '27TD':['27TD'], A5TD:['A5TD'], Badugi:['Badugi'], Badeucy:['Badeucy'], O8:['O8'], Stud8:['Stud8'], '27Razz':['27Razz'], '2-7 Single Draw No':['2-7 Single Draw No'], '7 Card Stud':['7 Card Stud'], Razz:['Razz']};
  const FAMN = {DRAW:'draw games', TD:'triple draw', ALLBLIND:'blind games', STUD:'stud games', '27TD':'2-7 TD', A5TD:'A-5 TD', Badugi:'Badugi', Badeucy:'Badeucy', O8:'Omaha Hi/Lo', Stud8:'Stud Hi/Lo', '27Razz':'2-7 Razz', '2-7 Single Draw No':'2-7 Single Draw', '7 Card Stud':'Stud High', Razz:'Razz'};
  const STUDFAM = new Set(['STUD','Stud8','27Razz','7 Card Stud','Razz']);
  const STATS = [ // [name, num, den, studOnly|blindOnly|any, drawOnly]
    ['VPIP','vpip','hands','any'],['PFR','pfr','hands','any'],['Open-limp','open_limp','open_opp','any'],['3-bet','threebet','face_open','any'],
    ['Cold-call','cold_call','face_open','blind'],['Steal','steal','steal_opp','blind'],['Fold to steal','fold_steal','vs_steal','blind'],
    ['WTSD','wtsd','saw_post','any'],['W$SD','wsd','wtsd','any'],['Check-raise','xr','xr_opp','any'],
    ['Fold 1st-draw bet','r1_fold_bet','r1_face_bet','blind'],['Fold 2nd-draw bet','r2_fold_bet','r2_face_bet','any'],['Fold river bet','r3_fold_bet','r3_face_bet','blind'],
    ['Fold vs pat river bet','fold_pat_river_bet','vs_pat_river_bet','draw'],['River bets shown weak','rbet_sd_weak','rbet_sd','draw'],['River calls shown weak','rcall_sd_weak','rcall_sd','draw'],
    ['Pat-final shown weak (snow)','snow_sd','pat_final_sd','draw'],['Pat on 1st draw','d1_pat','d1_n','draw'],['Bets with draw lead','fewer_bet','fewer_opp','draw'],['Leads drawing more','more_lead','more_opp','draw'],
    ['Bring-in folds to complete','bi_fold','bi_vs_complete','stud'],['Fold 4th st bet','r1_fold_bet','r1_face_bet','stud'],['Fold 7th st bet','r4_fold_bet','r4_face_bet','stud']];
  const READ = {
    'VPIP': ['Plays loose: value-bet thinner, fewer bluffs multiway', 'Plays tight: steal more, respect their entries'],
    'PFR': ['Raises a lot: re-raise and cap wider for value', 'Rarely raises: their raises are strong'],
    'Open-limp': ['Open-limps: isolate with raises', null],
    '3-bet': ['3-bets a lot: re-raise and call down wider for value', 'Rarely 3-bets: their 3-bets are strong'],
    'Cold-call': ['Cold-calls a lot: isolate and value-bet', 'Rarely cold-calls: folds or 3-bets'],
    'Steal': ['Steals a lot: defend and 3-bet wider against them', 'Rarely steals: their late opens are real'],
    'Fold to steal': ['Folds blinds: steal wider', 'Defends blinds: steal less, open for value'],
    'WTSD': ['Goes to showdown: no bluffs, thin value', 'Gives up before showdown: bluff more'],
    'W$SD': ['Wins at showdown: give their calls credit', 'Loses at showdown: calls too light, value-bet them'],
    'Check-raise': ['Check-raises a lot: check back marginal hands', 'Rarely check-raises: their checks are weak'],
    'Fold 1st-draw bet': ['Folds to 1st-draw bets: bet the flop', 'Never folds the 1st draw'],
    'Fold 2nd-draw bet': ['Folds to 2nd-draw bets: barrel the turn', 'Rarely folds the 2nd draw: cut semibluffs'],
    'Fold river bet': ['Overfolds the river: bluff and snow', 'Rarely folds the river: no bluffs, value-bet thin'],
    'Fold vs pat river bet': ['Believes pat hands: snow them', 'Does not believe pats: do not snow'],
    'River bets shown weak': ['Bluffs the river: bluff-catch wider', 'Honest river bettor: fold more to them'],
    'River calls shown weak': ['Calls the river light: value-bet thin', null],
    'Pat-final shown weak (snow)': ['Snows often: call their pat bets wider', null],
    'Pat on 1st draw': ['Stands pat early often: weak pats likely', 'Rarely pats early'],
    'Bets with draw lead': ['Always bets the draw lead', 'Checks with the draw lead: expect check-raises'],
    'Leads drawing more': ['Leads while drawing more: often a bluff', 'Never leads drawing more'],
    'Bring-in folds to complete': ['Folds the bring-in: steal it', 'Defends the bring-in: steal less'],
    'Fold 4th st bet': ['Folds to 4th-street bets: bet 4th', 'Never folds 4th street'],
    'Fold 7th st bet': ['Folds to 7th-street bets: bluff the end', 'Calls 7th street: no bluffs']};
  const GN = {'27TD':'2-7 TD', A5TD:'A-5 TD', O8:'O8', Stud8:'Stud8', '27Razz':'2-7 Razz', '2-7 Single Draw No':'2-7 SD', '7 Card Stud':'Stud', 'Omaha Pot':'PLO', "Hold'em No":'NLHE', "Hold'em":'LHE'};

  function buildCards(acc, notes) {
    // index counts: fmt -> player -> game -> array
    if (!acc.raw) acc = collapse(acc, Infinity);
    const by = {C: {}, T: {}}, byR = {C: {}, T: {}};
    for (const [k, v] of Object.entries(acc.counts)) {
      const [fmt, ...rest] = k.split('|'); const g = rest.pop(); const p = rest.join('|');
      ((by[fmt][p] = by[fmt][p] || {}))[g] = v; ((byR[fmt][p] = byR[fmt][p] || {}))[g] = acc.raw[k];
    }
    const sum = (games, gs, f) => { let s = 0; for (const g of gs) if (games[g]) s += games[g][FI[f]]; return s; };
    const cards = {};
    for (const fmt of ['C', 'T']) {
      const P = by[fmt], PR = byR[fmt]; const players = Object.keys(P);
      // pool totals per family/stat
      const pool = {};
      for (const [fam, gs] of Object.entries(FAMS)) for (const [, n, d] of STATS) {
        const key = fam + '|' + n + '|' + d; if (pool[key]) continue;
        let nn = 0, dd = 0; for (const p of players) { nn += sum(P[p], gs, n); dd += sum(P[p], gs, d); }
        pool[key] = [nn, dd];
      }
      const blindVpip = pool['ALLBLIND|vpip|hands']; const poolVpip = blindVpip[1] ? 100 * blindVpip[0] / blindVpip[1] : 40;
      for (const p of players) {
        const games = P[p], rgames = PR[p]; const hands = Math.round(Object.values(rgames).reduce((s, a) => s + a[0], 0));
        const c = cards[p] || (cards[p] = {player: p, cash_hands: 0, tour_hands: 0, games: {}, last_seen: ''});
        c[fmt === 'C' ? 'cash_hands' : 'tour_hands'] = hands;
        for (const [g, a] of Object.entries(rgames)) c.games[g] = (c.games[g] || 0) + a[0];
        const ls = acc.last[fmt + '|' + p]; if (ls && ls > c.last_seen) c.last_seen = ls;
        if (hands < 50) continue;
        const rate = (gs, n, d, mn = 20) => { if (sum(rgames, gs, d) < mn) return null; const dd = sum(games, gs, d); return dd > 0 ? Math.round(1000 * sum(games, gs, n) / dd) / 10 : null; };
        const pre = fmt === 'C' ? 'cash' : 'tour';
        c[pre + '_vpip'] = rate(BLIND, 'vpip', 'hands'); c[pre + '_pfr'] = rate(BLIND, 'pfr', 'hands');
        c[pre + '_3bet'] = rate(BLIND, 'threebet', 'face_open'); c[pre + '_fold_steal'] = rate(BLIND, 'fold_steal', 'vs_steal');
        c[pre + '_wtsd'] = rate(DR, 'wtsd', 'saw_post'); c[pre + '_fold_river'] = rate(DR, 'r3_fold_bet', 'r3_face_bet');
        const v = rate(BLIND, 'vpip', 'hands', 100), r = rate(BLIND, 'pfr', 'hands', 100), lp = rate(BLIND, 'open_limp', 'open_opp', 40);
        let style = null;
        if (v !== null && r !== null) {
          if (lp !== null && lp >= 15) style = 'Limper';
          else { const ag = v ? r / v : 0; style = v >= poolVpip + 8 ? (ag >= 0.6 ? 'Loose-aggressive' : 'Loose-passive') : v <= poolVpip - 8 ? (ag >= 0.6 ? 'Tight-aggressive' : 'Tight-passive') : 'Standard'; }
        }
        c[pre + '_style'] = style;
        // z-scored reads
        const found = [];
        for (const [fam, gs] of Object.entries(FAMS)) for (const [name, n, d, scope] of STATS) {
          const isStud = STUDFAM.has(fam);
          if (scope === 'stud' && !isStud) continue;
          if (scope !== 'stud' && scope !== 'any' && isStud) continue;
          if (scope === 'any' && isStud && !['VPIP','PFR','Open-limp','3-bet','WTSD','W$SD','Check-raise','Fold 2nd-draw bet'].includes(name)) continue;
          if (scope === 'draw' && ['O8','ALLBLIND','2-7 Single Draw No'].includes(fam)) continue;
          if (sum(rgames, gs, d) < 25) continue; const dn = sum(games, gs, d); if (dn < 5) continue;
          const nn = sum(games, gs, n); const [pn, pd] = pool[fam + '|' + n + '|' + d];
          const P2 = (pn - nn) / Math.max(1, pd - dn);
          const se = Math.sqrt(Math.max(P2 * (1 - P2), 1e-4) / dn); const z = (nn / dn - P2) / se;
          if (Math.abs(z) >= 2.5) found.push({name, fam, val: 100 * nn / dn, pool: 100 * P2, z});
        }
        found.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
        const seen = new Set(), reads = [];
        for (const f of found) {
          if (seen.has(f.name)) continue; const t = READ[f.name][f.z > 0 ? 0 : 1]; if (!t) continue;
          seen.add(f.name); reads.push({text: t, stat: f.name, val: Math.round(f.val), pool: Math.round(f.pool), games: FAMN[f.fam] || f.fam, dir: f.z > 0 ? 1 : -1});
          if (reads.length >= 5) break;
        }
        c[pre + '_reads'] = reads;
      }
    }
    const rows = Object.values(cards).filter(c => Math.max(c.cash_hands, c.tour_hands) >= 50).map(c => {
      c.main_games = Object.entries(c.games).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g, n]) => (GN[g] || g) + ' ' + n).join(', ');
      c.style = c.cash_style || c.tour_style || 'Standard'; c.note = (notes && notes[c.player]) || ''; delete c.games; return c;
    });
    rows.sort((a, b) => (b.cash_hands + b.tour_hands) - (a.cash_hands + a.tour_hands));
    return rows;
  }
  const api = {FIELDS, parse, count, merge, collapse, buildCards, empty: () => ({counts: {}, last: {}})};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PhenomEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
