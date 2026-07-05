/* metro.js — "metro map + lens" knockout view, ported from the worldcup2026
   PWA and adapted for Liquipedia Dota brackets (multiple stacked brackets,
   qualification columns, Bo-series scores, no clocks).

   Map: SVG stations (matches) + colored segments (paths). Decided matches
   collapse to the winner's logo; live matches pulse; TBD slots are hollow.
   Lens: focused match with feeder mini-cards, the full match card (tap to
   expand picks), and a "winner advances to" destination. Chevrons/swipe
   navigate within a round; tapping a team traces its route. */
'use strict';

const Metro = (() => {
  const { h, teamImg, logoOf, matchState } = UI;

  const W = 390;                 // viewBox width
  const ST_H = 26;               // station pill height
  const ROW_H = 78;              // vertical rhythm between rounds (rows)
  const SEC_GAP = 34;            // gap between stacked brackets

  // persistent view state across re-renders, kept per mount key so multiple
  // bracket tabs (Survival / Playoffs) don't clobber each other's focus
  const states = {};             // key -> {focus: {b,kind,r,i}, trace: name}
  let cur = null;                // state of the current mount
  let refs = {};                 // dom refs of current mount

  const key = (f) => f ? `${f.b}:${f.kind}:${f.r}:${f.i}` : '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      // 3rd place is fed by the final's feeders (SF losers)
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
  // Rounds are ROWS flowing top -> bottom (like the worldcup2026 map), so the
  // lens directions line up with the map: feeders come from the row above,
  // the destination is the row below, and prev/next moves along the row.
  function layout(brackets) {
    const geo = {};   // key -> {x,y,w,h}
    const secs = [];  // section label positions
    let y = 8;
    brackets.forEach((b, bi) => {
      const hasQualRow = (b.quals || []).length > 0;
      secs.push({ label: b.name, y: y + 12 });
      const rowNames = b.roundNames.concat(hasQualRow ? [b.qualHeader || 'Qualified'] : []);
      const y0 = y + 46 + ST_H / 2;                 // section label + first row label
      const rowY = (r) => y0 + r * ROW_H;

      b.rounds.forEach((ms, r) => {
        const colW = (W - 16) / Math.max(ms.length, 1);
        ms.forEach((m, i) => {
          const feeds = (m.feeders || []).map((j) => geo[`${bi}:m:${r - 1}:${j}`]).filter(Boolean);
          const x = feeds.length
            ? feeds.reduce((s, g) => s + g.x, 0) / feeds.length
            : 8 + colW * (i + 0.5);
          geo[`${bi}:m:${r}:${i}`] = { x, y: rowY(r) };
        });
      });
      (b.quals || []).forEach((q) => {
        const src = geo[`${bi}:m:${q.fromRound}:${q.fromIndex}`];
        if (src) geo[`${bi}:q:${q.fromRound}:${q.fromIndex}`] = { x: src.x, y: rowY(b.rounds.length) };
      });
      const lastRow = rowY(b.rounds.length - 1 + (hasQualRow ? 1 : 0));
      if (b.thirdPlace) {
        // beside the grand final, same row
        const fin = geo[`${bi}:m:${b.rounds.length - 1}:0`];
        geo[`${bi}:3rd:0:0`] = { x: W - 62, y: fin ? fin.y : lastRow };
      }
      geo[`sec:${bi}`] = { rowNames, rowY };
      y = lastRow + ST_H / 2 + 16 + SEC_GAP;
    });
    return { geo, secs, H: y };
  }

  // ------------------------------------------------------------ stations
  function svgImg(t, x, yy, sz, op) {
    const src = logoOf(t);
    if (!src) return '';
    return `<image href="${esc(src)}" x="${(x - sz / 2).toFixed(1)}" y="${(yy - sz / 2).toFixed(1)}" width="${sz}" height="${sz}" opacity="${op == null ? 1 : op}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  function stationSVG(m, g, f) {
    const st = stateOf(m);
    const cx = g.x, cy = g.y;
    let w, inner = '';
    const pill = (ww) =>
      `<rect class="mt-pill mt-r-${st}" x="${(cx - ww / 2).toFixed(1)}" y="${cy - ST_H / 2}" width="${ww}" height="${ST_H}" rx="${ST_H / 2}"/>`;
    const ring = (ww) =>
      `<rect class="mt-livering" x="${(cx - ww / 2 - 3).toFixed(1)}" y="${cy - ST_H / 2 - 3}" width="${ww + 6}" height="${ST_H + 6}" rx="${(ST_H + 6) / 2}"/>`;

    const t1 = m.team1 && m.team1.name ? m.team1 : null;
    const t2 = m.team2 && m.team2.name ? m.team2 : null;
    if (!t1 && !t2) {
      w = ST_H;
      inner = `<circle class="mt-hollow" cx="${cx}" cy="${cy}" r="${ST_H / 2 - 1}"/><text class="mt-qmark" x="${cx}" y="${cy}">?</text>`;
    } else {
      // both teams always visible; on decided matches the loser is dimmed
      w = Math.round(ST_H * 2);
      if (st === 'live') inner += ring(w);
      inner += pill(w);
      const sz = ST_H - 7, off = w * 0.24;
      const wt = st === 'done' ? winnerTeam(m) : null;
      const op = (t) => (wt && t !== wt ? 0.32 : 1);
      inner += t1 ? svgImg(t1, cx - off, cy, sz, op(m.team1)) : `<text class="mt-qmark" x="${cx - off}" y="${cy}">?</text>`;
      inner += t2 ? svgImg(t2, cx + off, cy, sz, op(m.team2)) : `<text class="mt-qmark" x="${cx + off}" y="${cy}">?</text>`;
      if (wt) {
        // subtle ring under the winner's logo
        inner += `<circle class="mt-winring" cx="${wt === m.team1 ? cx - off : cx + off}" cy="${cy}" r="${sz / 2 + 2.5}"/>`;
      }
      if ((st === 'live' || st === 'done') && m.score1 != null && m.score2 != null) {
        const b1 = m.winner === 1 ? ' class="mt-score-w"' : '';
        const b2 = m.winner === 2 ? ' class="mt-score-w"' : '';
        inner += `<text class="mt-score" x="${cx}" y="${cy + ST_H / 2 + 11}"><tspan${b1}>${esc(m.score1)}</tspan>–<tspan${b2}>${esc(m.score2)}</tspan></text>`;
      }
    }
    g.w = w; g.h = ST_H;
    return `<g class="mt-station" data-key="${key(f)}" data-names="${esc(stName(m))}">${inner}</g>`;
  }

  function qualSVG(q, g) {
    const t = q.team && q.team.name ? q.team : null;
    let inner;
    if (t) inner = `<circle class="mt-pill mt-r-done" cx="${g.x}" cy="${g.y}" r="${ST_H / 2 + 2}"/>` + svgImg(t, g.x, g.y, ST_H - 4);
    else inner = `<circle class="mt-hollow" cx="${g.x}" cy="${g.y}" r="${ST_H / 2 - 1}"/><text class="mt-qmark" x="${g.x}" y="${g.y}">?</text>`;
    g.w = ST_H + 4; g.h = ST_H + 4;
    return `<g class="mt-station mt-qual" data-names="${esc(t ? t.name : '')}">${inner}</g>`;
  }

  function segPath(a, b) {
    // vertical flow: child (row above) bottom edge -> parent (row below) top edge
    const y1 = a.y + ST_H / 2 + 4, y2 = b.y - ST_H / 2 - 4;
    const my = (y1 + y2) / 2;
    return `M ${a.x.toFixed(1)} ${y1.toFixed(1)} C ${a.x.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${my.toFixed(1)}, ${b.x.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function renderMap(brackets) {
    const { geo, secs, H } = layout(brackets);
    let segs = '', sts = '', labels = '';

    secs.forEach((s) => { labels += `<text class="mt-slabel" x="10" y="${s.y}">${esc(s.label)}</text>`; });

    brackets.forEach((b, bi) => {
      const sec = geo[`sec:${bi}`];
      sec.rowNames.forEach((name, r) => {
        labels += `<text class="mt-rowlab" x="10" y="${sec.rowY(r) - ST_H / 2 - 8}">${esc(name)}</text>`;
      });

      b.rounds.forEach((ms, r) => ms.forEach((m, i) => {
        const f = { b: bi, kind: 'm', r, i };
        const g = geo[key(f)];
        // segments to parent (colored by this match's state; winner name for trace)
        (m.feeders || []).forEach((j) => {
          const child = b.rounds[r - 1][j];
          const cg = geo[`${bi}:m:${r - 1}:${j}`];
          const cst = stateOf(child);
          const wname = cst === 'done' && winnerTeam(child) ? winnerTeam(child).name : stName(child);
          segs += `<path class="mt-seg ${cst === 'live' ? 'mt-seg-live' : cst === 'up' ? 'mt-seg-up mt-dashed' : ''}" data-ids="${esc(wname)}" d="${segPath(cg, g)}"/>`;
        });
      }));

      // draw stations after segments
      b.rounds.forEach((ms, r) => ms.forEach((m, i) => {
        const f = { b: bi, kind: 'm', r, i };
        sts += stationSVG(m, geo[key(f)], f);
      }));

      (b.quals || []).forEach((q) => {
        const mg = geo[`${bi}:m:${q.fromRound}:${q.fromIndex}`];
        const qg = geo[`${bi}:q:${q.fromRound}:${q.fromIndex}`];
        if (!mg || !qg) return;
        const m = b.rounds[q.fromRound][q.fromIndex];
        const st = stateOf(m);
        const wname = st === 'done' && winnerTeam(m) ? winnerTeam(m).name : '';
        segs += `<path class="mt-seg ${st === 'live' ? 'mt-seg-live' : st === 'up' ? 'mt-seg-up mt-dashed' : ''}" data-ids="${esc(wname)}" d="${segPath(mg, qg)}"/>`;
        sts += qualSVG(q, qg);
      });

      if (b.thirdPlace) {
        const f = { b: bi, kind: '3rd', r: 0, i: 0 };
        const g = geo[key(f)];
        labels += `<text class="mt-rlabel" x="${g.x}" y="${g.y - ST_H / 2 - 8}">3rd place</text>`;
        sts += stationSVG(b.thirdPlace, g, f);
      }
      // trophy next to the grand final
      const fin = geo[`${bi}:m:${b.rounds.length - 1}:0`];
      if (fin && !(b.quals || []).length)
        labels += `<text class="mt-trophy" x="${fin.x - ST_H - 18}" y="${fin.y}">🏆</text>`;
    });

    refs.canvas.innerHTML =
      `<svg id="metroMap" viewBox="0 0 ${W} ${Math.ceil(H)}" xmlns="http://www.w3.org/2000/svg" aria-label="Knockout map">` +
      `<g>${segs}</g><g>${sts}</g><g>${labels}</g>` +
      `<g class="mt-focusring" id="mtFring" style="display:none"><rect/></g></svg>`;
    refs.geo = geo;
  }

  // ------------------------------------------------------------ lens
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
    btn.addEventListener('click', () => setFocus(f));
    return btn;
  }

  function renderLens(brackets) {
    const f = cur.focus;
    const m = matchAt(brackets, f);
    if (!m) { refs.inner.innerHTML = ''; return; }
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
    // trace on team tap
    card.querySelectorAll('.m-trow').forEach((row, idx) => {
      row.addEventListener('click', (e) => {
        const t = idx === 0 ? m.team1 : m.team2;
        if (!t || !t.name) return;
        e.stopPropagation();
        setTrace(cur.trace === t.name ? null : t.name);
      });
    });

    // destination
    let dest;
    const par = f.kind === '3rd' ? null : parentOf(brackets, f);
    const q = f.kind === '3rd' ? null : qualOf(b, f);
    if (par) {
      const pm = matchAt(brackets, par);
      const w = st === 'done' ? winnerTeam(m) : null;
      dest = h('button', { class: 'lens-dest', type: 'button' },
        h('span', { class: 'dt' }, 'Winner advances to'),
        h('span', { class: 'db' }, w ? teamImg(w, '') : null,
          `${b.roundNames[par.r] || 'next round'}${(b.rounds[par.r] || []).length > 1 ? ' · Match ' + (par.i + 1) : ''}`));
      dest.addEventListener('click', () => setFocus(par));
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
        badge, h('span', { class: 'lens-pos' }, `${pos} / ${N}`)),
      feeders, conn, card, h('div', { class: 'lens-conn' }, '▼'), dest);

    refs.prev.disabled = refs.next.disabled = (N <= 1);
  }

  // --------------------------------------------------- focus/trace/sync
  function syncMap() {
    const svg = refs.canvas.querySelector('svg');
    if (!svg) return;
    const fring = svg.querySelector('#mtFring'), rect = fring.querySelector('rect');
    const g = refs.geo[key(cur.focus)];
    if (g) {
      const pad = 5, rw = (g.w || ST_H * 2) + pad * 2, rh = (g.h || ST_H) + pad * 2;
      rect.setAttribute('x', -rw / 2); rect.setAttribute('y', -rh / 2);
      rect.setAttribute('width', rw); rect.setAttribute('height', rh); rect.setAttribute('rx', rh / 2);
      fring.setAttribute('transform', `translate(${g.x},${g.y})`);
      fring.style.display = '';
    } else fring.style.display = 'none';

    const trace = cur.trace;
    svg.classList.toggle('trace', !!trace);
    svg.querySelectorAll('.mt-station').forEach((s) => {
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
    const svg = refs.canvas.querySelector('svg');
    const g = refs.geo[key(cur.focus)];
    if (!svg || !g) return;
    const scale = svg.clientWidth / W || 1;
    let top = refs.canvas.offsetTop + g.y * scale - refs.pane.clientHeight * 0.45;
    top = Math.max(0, Math.min(top, refs.pane.scrollHeight - refs.pane.clientHeight));
    refs.pane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  function setFocus(f, opts = {}) {
    cur.focus = f;
    renderLens(refs.brackets);
    syncMap();
    scrollToFocus(!opts.instant);
  }

  function setTrace(name) {
    cur.trace = name;
    syncMap();
  }

  function nav(dir) {
    const f = cur.focus;
    const b = refs.brackets[f.b];
    if (f.kind === '3rd') return;
    const N = (b.rounds[f.r] || []).length;
    if (N <= 1) return;
    setFocus({ ...f, i: (f.i + dir + N) % N });
  }

  // ------------------------------------------------------------ mount
  function mount(container, brackets, opts = {}) {
    const skey = opts.key || 'default';
    cur = states[skey] = states[skey] || { focus: null, trace: null };
    refs = { brackets };
    const legend = h('div', { class: 'metro-leg' },
      h('span', {}, h('span', { class: 'd green' }), 'live'),
      h('span', {}, h('span', { class: 'd amber' }), 'upcoming'),
      h('span', {}, h('span', { class: 'd gray' }), 'decided'));

    refs.canvas = h('div', { id: 'metroCanvas' });
    refs.clear = h('button', { class: 'metro-clearbtn', type: 'button', onclick: () => setTrace(null) }, '✕ clear route');
    refs.pane = h('div', { class: 'metro-pane' },
      h('div', { class: 'metro-head' }, h('span', { class: 'metro-ttl' }, 'Knockout map'), legend),
      refs.canvas);

    refs.inner = h('div', { class: 'lens-inner' });
    refs.prev = h('button', { class: 'lens-chev left', type: 'button', 'aria-label': 'Previous match', onclick: () => nav(-1) }, '‹');
    refs.next = h('button', { class: 'lens-chev right', type: 'button', 'aria-label': 'Next match', onclick: () => nav(1) }, '›');
    const lens = h('div', { class: 'lens' }, refs.prev, refs.next, refs.inner,
      h('div', { class: 'lens-hint' }, '‹ › browse round · tap team to trace route · tap card for picks'));

    const mapWrap = h('div', { class: 'metro-wrap' },
      h('div', { style: 'position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column' },
        refs.pane, h('div', { class: 'metro-fade' }), refs.clear),
      lens);
    container.append(mapWrap);

    renderMap(brackets);

    // validate / default focus
    if (!cur.focus || !matchAt(brackets, cur.focus)) cur.focus = defaultFocus(brackets);
    if (!cur.focus) return;

    // map taps
    refs.canvas.addEventListener('click', (e) => {
      const st = e.target.closest('.mt-station');
      if (!st || !st.dataset.key) return;
      const [b, kind, r, i] = st.dataset.key.split(':');
      setFocus({ b: +b, kind, r: +r, i: +i });
    });

    // swipe on lens
    let tx = null;
    lens.addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
    lens.addEventListener('touchend', (e) => {
      if (tx == null) return;
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 44) nav(dx < 0 ? 1 : -1);
      tx = null;
    }, { passive: true });

    renderLens(brackets);
    syncMap();
    requestAnimationFrame(() => scrollToFocus(false));
  }

  return { mount };
})();
