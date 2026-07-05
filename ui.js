/* ui.js — shared render helpers for the demos (no framework, no deps).
   Row/hero layout patterns adapted from the worldcup2026 PWA. */
'use strict';

const UI = (() => {
  // ------------------------------------------------------------- dom
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(9)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }

  function img(src, cls, alt = '') {
    if (!src) return h('span', { class: (cls || '') + ' img-missing' });
    const el = document.createElement('img');
    el.referrerPolicy = 'no-referrer';           // LP 403s localhost referers
    el.loading = 'lazy';
    el.decoding = 'async';
    el.alt = alt;
    if (cls) el.className = cls;
    el.addEventListener('error', () => el.classList.add('img-missing'));
    el.src = src;
    return el;
  }

  const isLight = () => document.documentElement.dataset.theme === 'light';
  // theme-aware logo (LP ships lightmode/darkmode variants)
  const logoOf = (t) => (t ? (isLight() && t.logoL ? t.logoL : t.logo) : '');
  const teamImg = (t, cls) => img(logoOf(t), cls || 'team-logo', (t && t.name) || '');

  // ------------------------------------------------------------- time
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  function relDay(ts) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(ts * 1000); that.setHours(0, 0, 0, 0);
    const diff = Math.round((that - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return null;
  }

  function countdown(ts, now = Date.now() / 1000) {
    let s = Math.floor(ts - now);
    if (s <= 0) return 'starting…';
    const d = Math.floor(s / 86400); s -= d * 86400;
    const hr = Math.floor(s / 3600); s -= hr * 3600;
    const min = Math.floor(s / 60);
    if (d > 0) return `${d}d ${hr}h`;
    if (hr > 0) return `${hr}h ${min}m`;
    return `${min}m ${String(s % 60).padStart(2, '0')}s`;
  }

  // update all [data-cd-ts] countdown nodes; call from a 1 s ticker
  function tickCountdowns() {
    document.querySelectorAll('[data-cd-ts]').forEach((el) => {
      el.textContent = (el.dataset.cdPrefix || '') + countdown(+el.dataset.cdTs);
    });
  }

  // LIVE = started less than ~2.5h per game ago and not marked finished
  function matchState(m, now = Date.now() / 1000) {
    if (m.finished) return 'finished';
    if (m.winner || m.draw) return 'finished';
    if (m.ts && m.ts <= now) {
      const budget = (m.bestOf || 3) * 4200 + 3600;
      return now - m.ts < budget ? 'live' : 'finished';
    }
    return 'upcoming';
  }

  const PROMO = { up: 'Playoffs', stayup: 'Survival (R2)', stay: 'Survival (R1)', down: 'Eliminated' };

  function shortStage(s) {
    return (s || '').replace('Group Stage', 'Groups').replace(/^Group /, 'Grp ');
  }

  function liveGameNo(m) {
    const played = (m.games || []).filter((g) => g.played).length;
    return m.bestOf ? Math.min(played + 1, m.bestOf) : played + 1;
  }

  // ------------------------------------------------------------- teams
  function teamCell(team, { win = false } = {}) {
    const name = (team && team.name) || 'TBD';
    return h('div', { class: `team-cell ${win ? 'win' : ''} ${team && team.name ? '' : 'tbd'}` },
      teamImg(team),
      h('span', { class: 'team-name' }, name));
  }

  // -------------------------------------------------------- match card
  const shortOf = (t) => (t && (t.short || t.name)) || 'TBD';

  function gameRow(g, i, m) {
    const strip = (picks, side, team) =>
      h('div', { class: `hero-strip ${side ? 'side-' + side : ''}`,
                 title: `${(team && team.name) || '?'} picks${side ? ' (' + side + ')' : ''}` },
        picks.length
          ? picks.map((p) => img(p.icon, 'hero-icon', p.name))
          : h('span', { class: 'dim tiny' }, '—'));
    return h('div', { class: `game-row ${g.winner ? 'won-' + g.winner : ''} ${g.played ? '' : 'unplayed'}` },
      strip(g.picks1, g.side1, m && m.team1),
      h('div', { class: 'game-mid' },
        h('div', { class: 'game-num' }, `G${i + 1}`),
        h('div', { class: 'game-dur' }, g.duration || '–')),
      strip(g.picks2, g.side2, m && m.team2));
  }

  // "TSpirit ⟵ picks ⟶ XG" header so left/right strips map to teams
  function detailHeader(m) {
    return h('div', { class: 'detail-teams' },
      h('span', { class: 'dt-side' }, teamImg(m.team1, 'team-logo'), shortOf(m.team1)),
      h('span', { class: 'dt-mid' }, 'picks'),
      h('span', { class: 'dt-side' }, shortOf(m.team2), teamImg(m.team2, 'team-logo')));
  }

  // worldcup2026-style row: left when-column, stacked teams, faint meta line
  function matchCard(m, { showStage = true } = {}) {
    const state = matchState(m);
    const hasGames = m.games && m.games.some((g) => g.played || (g.picks1 && g.picks1.length));

    let when;
    if (state === 'live') {
      when = h('div', { class: 'when' },
        h('span', { class: 'live-tag' }, h('span', { class: 'live-dot', style: 'display:inline-block;margin-right:3px' }), 'LIVE'),
        m.bestOf ? h('span', { class: 'cd' }, `Game ${liveGameNo(m)}`) : null);
    } else if (state === 'finished') {
      when = h('div', { class: 'when' }, h('span', { class: 'ft' }, m.draw ? 'Draw' : 'Final'));
    } else {
      when = h('div', { class: 'when' },
        m.ts ? fmtTime.format(new Date(m.ts * 1000)) : 'TBD',
        m.ts ? h('span', { class: 'cd', 'data-cd-ts': m.ts, 'data-cd-prefix': 'in ' }, `in ${countdown(m.ts)}`) : null);
    }

    const showScore = state !== 'upcoming';
    const trow = (team, score, winner, loser) =>
      h('div', { class: `m-trow ${loser ? 'loser' : ''}` },
        teamImg(team),
        h('span', { class: `nm ${team && team.name ? '' : 'tbd'}` }, (team && team.name) || 'TBD'),
        showScore ? h('span', { class: 'sc' }, score != null ? score : '–') : null);

    const metaParts = [];
    if (showStage && m.stage) metaParts.push(m.round ? `${shortStage(m.stage)} · ${m.round}` : shortStage(m.stage));
    else if (m.round) metaParts.push(m.round);
    if (m.bestOf) metaParts.push(`Bo${m.bestOf}`);
    if (m.draw) metaParts.push('series drawn');

    const card = h('div', { class: `match-card ${state}` },
      when,
      h('div', { class: 'm-teams' },
        trow(m.team1, m.score1, m.winner === 1, state === 'finished' && !m.draw && m.winner === 2),
        trow(m.team2, m.score2, m.winner === 2, state === 'finished' && !m.draw && m.winner === 1)),
      metaParts.length ? h('div', { class: 'gmeta' }, metaParts.join(' · ')) : null);

    if (hasGames || (m.links && m.links.length)) {
      card.classList.add('expandable');
      const detail = h('div', { class: 'match-detail' },
        hasGames ? detailHeader(m) : null,
        m.games.map((g, i) => (g.picks1.length || g.played ? gameRow(g, i, m) : null)),
        m.links && m.links.length
          ? h('div', { class: 'link-row' },
              m.links.filter((l) => ['VOD', 'Stream', 'H2H'].includes(l.label))
                .slice(0, 4)
                .map((l) => h('a', { class: 'link-btn', href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.label)))
          : null);
      card.append(detail);
      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        card.classList.toggle('open');
      });
    }
    return card;
  }

  // ----------------------------------------------------------- hero
  function heroCard(m, kind) {
    const live = kind === 'live';
    const tag = live
      ? h('div', { class: 'hero-tag' }, h('span', { class: 'live-dot' }),
          `Live · Game ${liveGameNo(m)}${m.bestOf ? ' of Bo' + m.bestOf : ''}`)
      : h('div', { class: 'hero-tag' }, 'Up Next');
    const mid = live
      ? h('div', { class: 'hero-score' }, `${m.score1 != null ? m.score1 : 0} – ${m.score2 != null ? m.score2 : 0}`)
      : h('div', { class: 'hero-vs' }, 'vs');
    const team = (t) => h('div', { class: 'hero-team' },
      teamImg(t, ''), h('span', { class: 'tname' }, (t && t.name) || 'TBD'));

    let sub = null;
    if (!live && m.ts) {
      const rel = relDay(m.ts);
      const when = (rel || fmtDay.format(new Date(m.ts * 1000))) + ' · ' + fmtTime.format(new Date(m.ts * 1000));
      sub = h('div', { class: 'hero-sub' },
        'Starts in ', h('b', { 'data-cd-ts': m.ts }, countdown(m.ts)), ` · ${when}`);
    } else if (live && m.games) {
      const done = m.games.filter((g) => g.played);
      if (done.length) {
        const last = done[done.length - 1];
        sub = h('div', { class: 'hero-sub' }, `last game ${last.duration || ''} · ${last.winner === 1 ? (m.team1 || {}).name || '' : (m.team2 || {}).name || ''} took G${done.length}`);
      }
    }
    const meta = [m.round ? `${shortStage(m.stage)} · ${m.round}` : shortStage(m.stage), m.bestOf ? `Bo${m.bestOf}` : null]
      .filter(Boolean).join(' · ');

    return h('div', { class: `hero-card ${live ? 'live' : 'next'}`, 'data-mid': m.id },
      tag,
      h('div', { class: 'hero-row' }, team(m.team1), h('div', { class: 'hero-mid' }, mid), team(m.team2)),
      sub,
      h('div', { class: 'hero-meta' }, meta));
  }

  // -------------------------------------------------------- standings
  function standingsTable(group, { compact = false } = {}) {
    return h('div', { class: 'standings' },
      group.rows.map((r) =>
        h('div', { class: `stand-row promo-${r.promo || 'none'}` },
          h('span', { class: 'stand-rank' }, r.rank || ''),
          teamImg(r),
          h('span', { class: 'stand-team' }, r.team),
          compact ? null : h('span', { class: 'stand-rec dim' }, r.games),
          h('span', { class: 'stand-rec main' }, r.series || '0-0'))));
  }

  function promoLegend(groups) {
    const used = new Set();
    groups.forEach((g) => g.rows.forEach((r) => r.promo && used.add(r.promo)));
    if (!used.size) return null;
    return h('div', { class: 'legend' },
      ['up', 'stayup', 'stay', 'down'].filter((p) => used.has(p)).map((p) =>
        h('span', { class: 'legend-item' }, h('span', { class: `dot promo-dot-${p}` }), PROMO[p])));
  }

  // ------------------------------------------- bracket columns (digest)
  function bracketView(bracket) {
    const wrap = h('div', { class: 'bracket-block' });
    const cols = h('div', { class: 'bracket-cols' });
    const chipBar = h('div', { class: 'chip-bar' });

    const colEls = [];
    const columns = bracket.rounds.map((ms, i) => ({ name: bracket.roundNames[i], matches: ms }));
    if (bracket.qualified && bracket.qualified.length)
      columns.push({ name: bracket.qualHeader || 'Qualified', qualified: bracket.qualified });

    columns.forEach((col, i) => {
      const chip = h('button', { class: 'chip-tab' + (i === 0 ? ' active' : '') }, col.name);
      chip.addEventListener('click', () => colEls[i].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
      chipBar.append(chip);

      const body = col.qualified
        ? h('div', { class: 'qual-list' },
            col.qualified.map((t) => h('div', { class: 'qual-row' }, teamImg(t), h('span', {}, t.name || 'TBD'))))
        : h('div', {}, col.matches.map((m) => matchCard(m, { showStage: false })),
            i === bracket.rounds.length - 1 && bracket.thirdPlace
              ? [h('div', { class: 'col-sub' }, '3rd place'), matchCard(bracket.thirdPlace, { showStage: false })]
              : null);

      const colEl = h('div', { class: 'bracket-col' }, h('div', { class: 'col-head' }, col.name), body);
      colEls.push(colEl);
      cols.append(colEl);
    });

    cols.addEventListener('scroll', () => {
      const idx = Math.round(cols.scrollLeft / (cols.scrollWidth / colEls.length));
      [...chipBar.children].forEach((c, i) => c.classList.toggle('active', i === Math.min(idx, colEls.length - 1)));
    }, { passive: true });

    wrap.append(h('div', { class: 'section-title' }, bracket.name), chipBar, cols);
    return wrap;
  }

  return { h, img, teamImg, logoOf, isLight, fmtTime, fmtDay, dayKey, relDay, countdown, tickCountdowns,
           matchState, liveGameNo, shortStage, matchCard, heroCard, teamCell, standingsTable, promoLegend, bracketView, PROMO };
})();
