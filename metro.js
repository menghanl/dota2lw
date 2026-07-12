/* metro.js — knockout map for Liquipedia Dota brackets.

   Map: SVG stations (rich match cards) + colored segments (paths).
   Decided matches dim the loser; live matches pulse; TBD slots are hollow.
   Details open as a popup when a station is selected (feeders, full match
   card, destination). Tap a team in the popup to trace its route. */
'use strict';

const Metro = (() => {
  const { h, teamImg, logoOf, matchState, fmtTime, fmtDay, relDay } = UI;

  const W = 390;                 // viewBox width
  const ST_H = 72;               // station card height (2 team rows + footer)
  const ROW_H = 120;             // vertical rhythm between rounds
  const SEC_GAP = 28;            // gap between stacked brackets
  const PAD_X = 10;

  // persistent view state across re-renders, kept per mount key so multiple
  // bracket tabs (Survival / Playoffs) don't clobber each other's focus
  const states = {};             // key -> {focus, trace, popup}
  let cur = null;                // state of the current mount
  let refs = {};                 // dom refs of current mount

  const key = (f) => f ? `${f.b}:${f.kind}:${f.r}:${f.i}` : '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function shortLabel(t, max = 8) {
    const s = (t && (t.short || t.name)) || '';
    if (!s) return 'TBD';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function cardW(count) {
    if (count <= 1) return 176;
    if (count === 2) return 156;
    if (count === 3) return 118;
    return 90; // 4-across
  }

  // ------------------------------------------------------------ topology
  function matchAt(brackets, f) {
    const b = brackets[f.b];
    if (!b) return null;
    if (f.kind === '3rd') return b.thirdPlace;
    return (b.rounds[f.r] || [])[f.i] || null;
  }
  function parentOf(brackets, f) {
    const b = brackets[f.b];
    if (f.kind === '3rd') return null;
    const next = b.rounds[f.r + 1];
    if (next) {
      for (let j = 0; j < next.length; j++)
        if ((next[j].feeders || []).includes(f.i)) return { b: f.b, kind: 'm', r: f.r + 1, i: j };
    }
    return null;
  }
  function qualOf(bracket, f) {
    return (bracket.quals || []).find((q) => q.fromRound === f.r && q.fromIndex === f.i) || null;
  }
  function childrenOf(brackets, f) {
    const b = brackets[f.b];
    if (f.kind === '3rd') {
      const fin = (b.rounds[b.rounds.length - 1] || [])[0];
      return (fin && fin.feeders || []).map((j) => ({ b: f.b, kind: 'm', r: b.rounds.length - 2, i: j }));
    }
    const m = matchAt(brackets, f);
    return (m && m.feeders || []).map((j) => ({ b: f.b, kind: 'm', r: f.r - 1, i: j }));
  }
  function stName(m) { return [(m.team1 || {}).name, (m.team2 || {}).name].filter(Boolean).join('|'); }
  function stateOf(m) { const s = matchState(m); return s === 'finished' ? 'done' : s === 'live' ? 'live' : 'up'; }
  function winnerTeam(m) { return m.winner === 1 ? m.team1 : m.winner === 2 ? m.team2 : null; }

  function defaultFocus(brackets) {
    const all = [];
    brackets.forEach((b, bi) => {
      b.rounds.forEach((ms, r) => ms.forEach((m, i) => all.push({ f: { b: bi, kind: 'm', r, i }, m })));
      if (b.thirdPlace) all.push({ f: { b: bi, kind: '3rd', r: 0, i: 0 }, m: b.thirdPlace });
    });
    if (!all.length) return null;
    const live = all.find((x) => stateOf(x.m) === 'live');
    if (live) return live.f;
    const ups = all.filter((x) => stateOf(x.m) === 'up' && x.m.ts).sort((a, b2) => a.m.ts - b2.m.ts);
    if (ups.length) return ups[0].f;
    return all[all.length - 1].f;
  }

  // ------------------------------------------------------------ geometry
  // Rounds are ROWS flowing top -> bottom. Feeders come from the row above;
  // the destination is the row below; prev/next moves along the row.
  function layout(brackets) {
    const geo = {};
    const secs = [];
    let y = 8;
    brackets.forEach((b, bi) => {
      const hasQualRow = (b.quals || []).length > 0;
      secs.push({ label: b.name, y: y + 12 });
      const rowNames = b.roundNames.concat(hasQualRow ? [b.qualHeader || 'Qualified'] : []);
      const y0 = y + 46 + ST_H / 2;
      const rowY = (r) => y0 + r * ROW_H;

      b.rounds.forEach((ms, r) => {
        const n = Math.max(ms.length, 1);
        const ww = cardW(n);
        const colW = (W - PAD_X * 2) / n;
        ms.forEach((m, i) => {
          const feeds = (m.feeders || []).map((j) => geo[`${bi}:m:${r - 1}:${j}`]).filter(Boolean);
          const x = feeds.length
            ? feeds.reduce((s, g) => s + g.x, 0) / feeds.length
            : PAD_X + colW * (i + 0.5);
          geo[`${bi}:m:${r}:${i}`] = { x, y: rowY(r), w: ww, h: ST_H, n };
        });
      });
      (b.quals || []).forEach((q) => {
        const src = geo[`${bi}:m:${q.fromRound}:${q.fromIndex}`];
        if (src) geo[`${bi}:q:${q.fromRound}:${q.fromIndex}`] = { x: src.x, y: rowY(b.rounds.length), w: 36, h: 36 };
      });
      const lastRow = rowY(b.rounds.length - 1 + (hasQualRow ? 1 : 0));
      if (b.thirdPlace) {
        const fin = geo[`${bi}:m:${b.rounds.length - 1}:0`];
        const tw = cardW(1);
        geo[`${bi}:3rd:0:0`] = { x: W - PAD_X - tw / 2, y: fin ? fin.y : lastRow, w: tw, h: ST_H, n: 1 };
      }
      geo[`sec:${bi}`] = { rowNames, rowY };
      y = lastRow + ST_H / 2 + 18 + SEC_GAP;
    });
    return { geo, secs, H: y };
  }

  // ------------------------------------------------------------ stations
  // Cards are HTML overlaid on the SVG (%, same box as the viewBox). Avoid
  // <foreignObject> — Safari/iOS scales FO content wrong vs the SVG, so rings
  // and dashed logo placeholders drift off the card.
  function svgImg(t, x, yy, sz, op) {
    const src = logoOf(t);
    if (!src) return '';
    return `<image href="${esc(src)}" x="${(x - sz / 2).toFixed(1)}" y="${(yy - sz / 2).toFixed(1)}" width="${sz}" height="${sz}" opacity="${op == null ? 1 : op}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  function whenLabel(ts, narrow) {
    const d = new Date(ts * 1000);
    const day = relDay(ts) || (narrow
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : fmtDay.format(d));
    const time = fmtTime.format(d);
    return `${day} · ${time}`;
  }

  function metaLine(m, st, narrow) {
    if (st === 'live') return narrow ? 'LIVE' : (m.bestOf ? `LIVE · Bo${m.bestOf}` : 'LIVE');
    if (st === 'done') return m.draw ? 'Draw' : 'Final';
    if (narrow) {
      if (m.ts) return whenLabel(m.ts, true);
      return m.bestOf ? `Bo${m.bestOf}` : '—';
    }
    const parts = [];
    if (m.ts) parts.push(whenLabel(m.ts, false));
    if (m.bestOf) parts.push(`Bo${m.bestOf}`);
    return parts.join(' · ') || '—';
  }

  // Same <img> box as real logos — empty <span> placeholders mis-align on iOS flex.
  const LOGO_PH = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
    '<circle cx="7" cy="7" r="5.2" fill="none" stroke="%236b7386" stroke-width="1.2" stroke-dasharray="2.2 2"/>' +
    '</svg>');

  function teamRowHTML(t, score, opts) {
    const { showScore, lose, winScore, nameMax } = opts;
    const src = logoOf(t) || LOGO_PH;
    const logo = `<img class="mt-logo${logoOf(t) ? '' : ' mt-logo-ph'}" src="${esc(src)}" alt="" referrerpolicy="no-referrer" draggable="false"/>`;
    const nm = shortLabel(t, nameMax);
    const sc = showScore
      ? `<span class="mt-sc${winScore ? ' win' : ''}">${esc(score != null ? score : '–')}</span>`
      : '';
    return `<span class="mt-row${lose ? ' lose' : ''}">${logo}<span class="mt-nm">${esc(nm)}</span>${sc}</span>`;
  }

  function stationHTML(m, g, f, mapH) {
    const st = stateOf(m);
    const w = g.w || cardW(g.n || 2);
    const hh = g.h || ST_H;
    const t1 = m.team1 && m.team1.name ? m.team1 : null;
    const t2 = m.team2 && m.team2.name ? m.team2 : null;
    const narrow = w < 110;
    const nameMax = narrow ? 7 : w < 140 ? 10 : 14;
    const showScore = st !== 'up' && (m.score1 != null || m.score2 != null);
    const wt = st === 'done' ? winnerTeam(m) : null;
    const x0 = g.x - w / 2;
    const y0 = g.y - hh / 2;
    g.w = w; g.h = hh;

    const o1 = { showScore, lose: !!(wt && t1 && t1 !== wt), winScore: m.winner === 1, nameMax };
    const o2 = { showScore, lose: !!(wt && t2 && t2 !== wt), winScore: m.winner === 2, nameMax };
    const footCls = st === 'live' ? ' live' : st === 'up' ? ' up' : '';

    const left = (x0 / W * 100).toFixed(3);
    const top = (y0 / mapH * 100).toFixed(3);
    const ww = (w / W * 100).toFixed(3);
    const hhPct = (hh / mapH * 100).toFixed(3);

    return `<button type="button" class="mt-station mt-st-${st}" data-key="${key(f)}" data-names="${esc(stName(m))}"` +
      ` style="left:${left}%;top:${top}%;width:${ww}%;height:${hhPct}%">` +
      `<span class="mt-card">` +
        `<span class="mt-body">` +
          teamRowHTML(t1, m.score1, o1) +
          teamRowHTML(t2, m.score2, o2) +
        `</span>` +
        `<span class="mt-foot${footCls}">${esc(metaLine(m, st, narrow))}</span>` +
      `</span></button>`;
  }

  function qualSVG(q, g) {
    const t = q.team && q.team.name ? q.team : null;
    const r = Math.min((g.h || 36) / 2, 18);
    let inner;
    if (t) inner = `<circle class="mt-pill mt-r-done" cx="${g.x}" cy="${g.y}" r="${r}"/>` + svgImg(t, g.x, g.y, r * 1.35);
    else inner = `<circle class="mt-hollow" cx="${g.x}" cy="${g.y}" r="${r - 2}"/><text class="mt-qmark" x="${g.x}" y="${g.y}">?</text>`;
    g.w = r * 2; g.h = r * 2;
    return `<g class="mt-qual" data-names="${esc(t ? t.name : '')}">${inner}</g>`;
  }

  function segPath(a, b) {
    const ah = (a.h || ST_H) / 2, bh = (b.h || ST_H) / 2;
    const y1 = a.y + ah + 3, y2 = b.y - bh - 3;
    const my = (y1 + y2) / 2;
    return `M ${a.x.toFixed(1)} ${y1.toFixed(1)} C ${a.x.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function renderMap(brackets) {
    const { geo, secs, H } = layout(brackets);
    const mapH = Math.ceil(H);
    let segs = '', quals = '', labels = '', stations = '';

    secs.forEach((s) => { labels += `<text class="mt-slabel" x="10" y="${s.y}">${esc(s.label)}</text>`; });

    brackets.forEach((b, bi) => {
      const sec = geo[`sec:${bi}`];
      sec.rowNames.forEach((name, r) => {
        labels += `<text class="mt-rowlab" x="10" y="${sec.rowY(r) - ST_H / 2 - 10}">${esc(name)}</text>`;
      });

      b.rounds.forEach((ms, r) => ms.forEach((m, i) => {
        const f = { b: bi, kind: 'm', r, i };
        const g = geo[key(f)];
        (m.feeders || []).forEach((j) => {
          const child = b.rounds[r - 1][j];
          const cg = geo[`${bi}:m:${r - 1}:${j}`];
          const cst = stateOf(child);
          const wname = cst === 'done' && winnerTeam(child) ? winnerTeam(child).name : stName(child);
          segs += `<path class="mt-seg ${cst === 'live' ? 'mt-seg-live' : cst === 'up' ? 'mt-seg-up mt-dashed' : ''}" data-ids="${esc(wname)}" d="${segPath(cg, g)}"/>`;
        });
      }));

      b.rounds.forEach((ms, r) => ms.forEach((m, i) => {
        const f = { b: bi, kind: 'm', r, i };
        stations += stationHTML(m, geo[key(f)], f, mapH);
      }));

      (b.quals || []).forEach((q) => {
        const mg = geo[`${bi}:m:${q.fromRound}:${q.fromIndex}`];
        const qg = geo[`${bi}:q:${q.fromRound}:${q.fromIndex}`];
        if (!mg || !qg) return;
        const m = b.rounds[q.fromRound][q.fromIndex];
        const st = stateOf(m);
        const wname = st === 'done' && winnerTeam(m) ? winnerTeam(m).name : '';
        segs += `<path class="mt-seg ${st === 'live' ? 'mt-seg-live' : st === 'up' ? 'mt-seg-up mt-dashed' : ''}" data-ids="${esc(wname)}" d="${segPath(mg, qg)}"/>`;
        quals += qualSVG(q, qg);
      });

      if (b.thirdPlace) {
        const f = { b: bi, kind: '3rd', r: 0, i: 0 };
        const g = geo[key(f)];
        labels += `<text class="mt-rlabel" x="${g.x}" y="${g.y - ST_H / 2 - 10}">3rd place</text>`;
        stations += stationHTML(b.thirdPlace, g, f, mapH);
      }
      const fin = geo[`${bi}:m:${b.rounds.length - 1}:0`];
      if (fin && !(b.quals || []).length)
        labels += `<text class="mt-trophy" x="${fin.x - (fin.w || 80) / 2 - 16}" y="${fin.y}">🏆</text>`;
    });

    refs.canvas.innerHTML =
      `<div class="metro-stage" style="aspect-ratio:${W}/${mapH}">` +
        `<svg id="metroMap" viewBox="0 0 ${W} ${mapH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-label="Knockout map">` +
          `<g>${segs}</g><g>${quals}</g><g>${labels}</g>` +
        `</svg>` +
        `<div class="metro-stations">${stations}</div>` +
      `</div>`;
    refs.geo = geo;
    refs.mapH = mapH;
  }

  // ------------------------------------------------------------ popup (ex-lens)
  function feederBtn(brackets, f) {
    const m = matchAt(brackets, f);
    if (!m) return h('div', { class: 'feeder ph' }, 'TBD');
    const st = stateOf(m);
    const w = winnerTeam(m);
    const side = (t, lose) => h('span', { class: `side ${lose ? 'lose' : ''}` },
      teamImg(t, ''), st !== 'up' ? h('span', { class: 'fs' }, t === m.team1 ? (m.score1 != null ? m.score1 : '') : (m.score2 != null ? m.score2 : '')) : null);
    const tag = st === 'live' ? h('em', {}, '● LIVE') : st === 'up' ? h('span', { class: 'up' }, 'upcoming') : h('span', {}, 'decided');
    const b = brackets[f.b];
    const name = f.kind === '3rd' ? '3rd place' : (b.roundNames[f.r] || `R${f.r + 1}`);
    const btn = h('button', { class: 'feeder', type: 'button' },
      h('span', { class: 'ft' }, h('span', {}, name), tag),
      h('span', { class: 'fb' },
        side(m.team1, st === 'done' && w && w !== m.team1),
        h('span', { class: 'vs' }, st === 'up' ? 'vs' : '–'),
        side(m.team2, st === 'done' && w && w !== m.team2)));
    btn.addEventListener('click', () => setFocus(f, { open: true }));
    return btn;
  }

  function renderPopup(brackets) {
    if (!cur.popup || !cur.focus) {
      refs.sheet.classList.remove('open');
      refs.backdrop.classList.remove('open');
      return;
    }
    const f = cur.focus;
    const m = matchAt(brackets, f);
    if (!m) {
      refs.sheet.classList.remove('open');
      refs.backdrop.classList.remove('open');
      return;
    }
    const b = brackets[f.b];
    const st = stateOf(m);
    const roundName = f.kind === '3rd' ? '3rd place match' : (b.roundNames[f.r] || `Round ${f.r + 1}`);
    const N = f.kind === '3rd' ? 1 : (b.rounds[f.r] || []).length;
    const pos = f.kind === '3rd' ? 1 : f.i + 1;

    const badge = st === 'live' ? h('span', { class: 'lens-state live' }, '● LIVE')
      : st === 'up' ? h('span', { class: 'lens-state up' }, '● Upcoming')
      : h('span', { class: 'lens-state done' }, '● Decided');

    const kids = childrenOf(brackets, f);
    const feeders = kids.length
      ? h('div', { class: 'feeders' }, kids.map((c) => feederBtn(brackets, c)))
      : h('div', { class: 'feeders' }, h('div', { class: 'feeder ph' },
          b.quals && b.quals.length ? 'Seeded from the group stage' : 'Qualified via Survival / groups'));
    const conn = h('div', { class: 'lens-conn' },
      kids.length ? (f.kind === '3rd' ? '▼ semifinal losers meet here' : '▼ winners meet here') : '▼');

    const card = UI.matchCard(m, { showStage: false });
    card.querySelectorAll('.m-trow').forEach((row, idx) => {
      row.addEventListener('click', (e) => {
        const t = idx === 0 ? m.team1 : m.team2;
        if (!t || !t.name) return;
        e.stopPropagation();
        setTrace(cur.trace === t.name ? null : t.name);
      });
    });

    let dest;
    const par = f.kind === '3rd' ? null : parentOf(brackets, f);
    const q = f.kind === '3rd' ? null : qualOf(b, f);
    if (par) {
      const w = st === 'done' ? winnerTeam(m) : null;
      dest = h('button', { class: 'lens-dest', type: 'button' },
        h('span', { class: 'dt' }, 'Winner advances to'),
        h('span', { class: 'db' }, w ? teamImg(w, '') : null,
          `${b.roundNames[par.r] || 'next round'}${(b.rounds[par.r] || []).length > 1 ? ' · Match ' + (par.i + 1) : ''}`));
      dest.addEventListener('click', () => setFocus(par, { open: true }));
    } else if (q) {
      const w = st === 'done' ? winnerTeam(m) : null;
      dest = h('div', { class: 'lens-dest champ' },
        h('span', { class: 'dt' }, 'Winner qualifies'),
        h('span', { class: 'db' }, w ? teamImg(w, '') : null, '→ ', b.qualHeader || 'Playoffs'));
    } else if (f.kind === '3rd') {
      dest = h('div', { class: 'lens-dest champ' }, h('span', { class: 'dt' }, 'Destination'), h('span', { class: 'db' }, '🥉 Third place'));
    } else {
      const w = st === 'done' ? winnerTeam(m) : null;
      dest = h('div', { class: 'lens-dest champ' },
        h('span', { class: 'dt' }, 'Destination'),
        h('span', { class: 'db' }, w ? teamImg(w, '') : null, w ? `🏆 ${w.name} — Champion` : '🏆 Champion'));
    }

    refs.inner.innerHTML = '';
    refs.inner.append(
      h('div', { class: 'lens-head' },
        h('span', { class: 'lens-title' }, `${b.name} · ${roundName}`),
        badge, h('span', { class: 'lens-pos' }, `${pos} / ${N}`),
        h('button', { class: 'lens-close', type: 'button', 'aria-label': 'Close', onclick: closePopup }, '✕')),
      feeders, conn, card, h('div', { class: 'lens-conn' }, '▼'), dest,
      h('div', { class: 'lens-hint' }, '‹ › browse round · tap team to trace route · tap card for picks'));

    refs.prev.disabled = refs.next.disabled = (N <= 1);
    refs.sheet.classList.add('open');
    refs.backdrop.classList.add('open');
  }

  // --------------------------------------------------- focus/trace/sync
  function syncMap() {
    const stage = refs.canvas.querySelector('.metro-stage');
    const svg = refs.canvas.querySelector('svg');
    if (!stage || !svg) return;

    const focusKey = cur.popup && cur.focus ? key(cur.focus) : null;
    stage.querySelectorAll('.mt-station').forEach((s) => {
      s.classList.toggle('focus', !!focusKey && s.dataset.key === focusKey);
    });

    const trace = cur.trace;
    stage.classList.toggle('trace', !!trace);
    svg.classList.toggle('trace', !!trace);
    stage.querySelectorAll('.mt-station').forEach((s) => {
      if (trace) {
        const names = (s.dataset.names || '').split('|');
        s.classList.toggle('on', names.includes(trace));
      } else s.classList.remove('on');
    });
    svg.querySelectorAll('.mt-seg').forEach((p) => {
      if (trace) p.classList.toggle('on', (p.dataset.ids || '').split('|').includes(trace));
      else p.classList.remove('on');
    });
    refs.clear.classList.toggle('show', !!trace);
    if (trace) refs.clear.textContent = `✕ route: ${trace}`;
  }

  function scrollToFocus(smooth) {
    const stage = refs.canvas.querySelector('.metro-stage');
    const g = refs.geo[key(cur.focus)];
    if (!stage || !g || !cur.popup) return;
    const scale = stage.clientWidth / W || 1;
    let top = refs.canvas.offsetTop + g.y * scale - refs.pane.clientHeight * 0.35;
    top = Math.max(0, Math.min(top, refs.pane.scrollHeight - refs.pane.clientHeight));
    refs.pane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  function setFocus(f, opts = {}) {
    cur.focus = f;
    if (opts.open !== false) cur.popup = true;
    renderPopup(refs.brackets);
    syncMap();
    scrollToFocus(false);
  }

  function closePopup() {
    cur.popup = false;
    renderPopup(refs.brackets);
    syncMap();
  }

  function setTrace(name) {
    cur.trace = name;
    syncMap();
  }

  function nav(dir) {
    const f = cur.focus;
    if (!f) return;
    const b = refs.brackets[f.b];
    if (f.kind === '3rd') return;
    const N = (b.rounds[f.r] || []).length;
    if (N <= 1) return;
    setFocus({ ...f, i: (f.i + dir + N) % N }, { open: true });
  }

  // ------------------------------------------------------------ mount
  function mount(container, brackets, opts = {}) {
    const skey = opts.key || 'default';
    cur = states[skey] = states[skey] || { focus: null, trace: null, popup: false };
    refs = { brackets };
    const legend = h('div', { class: 'metro-leg' },
      h('span', {}, h('span', { class: 'd green' }), 'live'),
      h('span', {}, h('span', { class: 'd amber' }), 'upcoming'),
      h('span', {}, h('span', { class: 'd gray' }), 'decided'));

    refs.canvas = h('div', { id: 'metroCanvas' });
    refs.clear = h('button', { class: 'metro-clearbtn', type: 'button', onclick: () => setTrace(null) }, '✕ clear route');
    refs.pane = h('div', { class: 'metro-pane' },
      h('div', { class: 'metro-head' },
        h('span', { class: 'metro-ttl' }, 'Knockout map'),
        legend,
        h('span', { class: 'metro-hint-inline' }, 'tap a match for details')),
      refs.canvas);

    refs.inner = h('div', { class: 'lens-inner' });
    refs.prev = h('button', { class: 'lens-chev left', type: 'button', 'aria-label': 'Previous match', onclick: () => nav(-1) }, '‹');
    refs.next = h('button', { class: 'lens-chev right', type: 'button', 'aria-label': 'Next match', onclick: () => nav(1) }, '›');
    refs.backdrop = h('div', { class: 'metro-backdrop', onclick: closePopup });
    refs.sheet = h('div', { class: 'metro-sheet', role: 'dialog', 'aria-modal': 'true' },
      refs.prev, refs.next, refs.inner);

    const mapWrap = h('div', { class: 'metro-wrap' },
      h('div', { class: 'metro-mapcol' },
        refs.pane, h('div', { class: 'metro-fade' }), refs.clear),
      refs.backdrop, refs.sheet);
    container.append(mapWrap);

    renderMap(brackets);

    if (!cur.focus || !matchAt(brackets, cur.focus)) cur.focus = defaultFocus(brackets);

    refs.canvas.addEventListener('click', (e) => {
      const st = e.target.closest('.mt-station');
      if (!st || !st.dataset.key) return;
      const [b, kind, r, i] = st.dataset.key.split(':');
      setFocus({ b: +b, kind, r: +r, i: +i }, { open: true });
    });

    // swipe on sheet
    let tx = null;
    refs.sheet.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
    refs.sheet.addEventListener('touchend', (e) => {
      if (tx == null) return;
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 44) nav(dx < 0 ? 1 : -1);
      tx = null;
    }, { passive: true });

    // Escape closes popup
    const onKey = (e) => { if (e.key === 'Escape' && cur.popup) closePopup(); };
    document.addEventListener('keydown', onKey);
    // no cleanup hook on remount — page re-render replaces the whole main

    renderPopup(brackets);
    syncMap();
  }

  return { mount };
})();
