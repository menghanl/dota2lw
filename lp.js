/* lp.js — frontend-only Liquipedia data layer.
 *
 * Fetches rendered wiki HTML via the MediaWiki API (action=parse, origin=*
 * CORS) and parses it into a clean JSON tournament model with DOMParser.
 *
 * Politeness: responses are cached in localStorage (parsed model, not raw
 * HTML), API hits are spaced >= 2s apart per Liquipedia API terms.
 * Attribution: data & images (c) Liquipedia, CC BY-SA 3.0.
 */
'use strict';

const LP = (() => {
  const WIKI = 'https://liquipedia.net';
  const API = WIKI + '/dota2/api.php';
  const PARSER_VERSION = 9;
  const CACHE_TTL_MS = 5 * 60 * 1000;      // 5 min
  const REQUEST_SPACING_MS = 2100;          // >= 1 req / 2 s

  // ---------------------------------------------------------------- utils
  const $ = (el, sel) => el.querySelector(sel);
  const $$ = (el, sel) => [...el.querySelectorAll(sel)];
  const txt = (el) => (el ? el.textContent.trim() : '');
  const abs = (u) => (!u ? '' : u.startsWith('http') ? u : WIKI + u);

  function pickLogo(scope) {
    if (!scope) return '';
    const img =
      $(scope, '.team-template-image-icon.darkmode img') ||
      $(scope, '.team-template-image-icon.team-template-darkmode img') ||
      $(scope, '.team-template-image-icon img') ||
      $(scope, 'img');
    return img ? abs(img.getAttribute('src')) : '';
  }

  // light-theme variant (LP ships lightmode/darkmode logo pairs; allmode has neither class)
  function pickLogoLight(scope) {
    if (!scope) return '';
    const img =
      $(scope, '.team-template-image-icon.lightmode img') ||
      $(scope, '.team-template-image-icon.team-template-lightmode img') ||
      $(scope, '.team-template-image-icon:not(.darkmode):not(.team-template-darkmode) img') ||
      $(scope, 'img');
    return img ? abs(img.getAttribute('src')) : '';
  }

  function logoPair(scope) {
    const dark = pickLogo(scope);
    const light = pickLogoLight(scope);
    return { logo: dark, logoL: light !== dark ? light : '' };
  }

  function teamFromBlock(block) {
    // .block-team (bracket entries, matchlist cells, popup headers)
    if (!block) return null;
    const dyn = $(block, '.team-name-dynamic');
    const name =
      (dyn && (dyn.dataset.teamName || dyn.dataset.teamBracketname)) ||
      txt($(block, '.name')) || null;
    return {
      name: name === 'TBD' ? null : name,
      short: dyn ? dyn.dataset.teamShortname || null : null,
      ...logoPair(block),
    };
  }

  // ------------------------------------------------------------- fetching
  let lastRequestAt = 0;
  async function apiFetch(page, opts) {
    const src = (opts && opts.src) || 'live';
    let url;
    if (src === 'local') {
      url = 'fixtures/' + page.replace(/\//g, '_') + '.json';
    } else {
      const wait = lastRequestAt + REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      // 60s CDN/browser cache: fresh enough for live scores, and all viewers
      // share one parse per page per minute on Liquipedia's side
      url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&origin=*&maxage=60&smaxage=60`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${page}`);
    const data = await res.json();
    if (data.error) throw new Error(`API error: ${data.error.info || data.error.code}`);
    return data.parse.text['*'];
  }

  function cacheKey(page, src) { return `lpv${PARSER_VERSION}:${src}:${page}`; }

  // ---------------------------------------------------------- match popup
  function parsePopup(popup) {
    if (!popup) return {};
    const out = { games: [], links: [] };

    const timer = $(popup, '.timer-object');
    if (timer) {
      out.ts = parseInt(timer.dataset.timestamp, 10) || null;
      out.finished = timer.dataset.finished === 'finished';
      out.dateText = txt(timer);
    }

    // header: opponents + Bo / score
    const header = $(popup, '.match-info-header');
    if (header) {
      const opps = $$(header, '.match-info-header-opponent .block-team');
      if (opps.length === 2) {
        out.team1 = teamFromBlock(opps[0]);
        out.team2 = teamFromBlock(opps[1]);
      }
      const lower = txt($(header, '.match-info-header-scoreholder-lower'));
      const upper = txt($(header, '.match-info-header-scoreholder-upper'));
      const boM = (lower + ' ' + upper).match(/Bo(\d)/i);
      if (boM) out.bestOf = parseInt(boM[1], 10);
      const scoreM = upper.match(/^(\d+)\s*[:\u2013-]\s*(\d+)$/);
      if (scoreM) out.scores = [parseInt(scoreM[1], 10), parseInt(scoreM[2], 10)];
    }

    // body: one grid row per game
    for (const row of $$(popup, '.brkts-popup-body-grid-row')) {
      const labels = $$(row, '.generic-label');
      const detail = $(row, '.brkts-popup-body-grid-row-detail');
      if (!detail) continue;
      const thumbs = $$(detail, '.brkts-popup-body-element-thumbs');
      const heroesOf = (t) =>
        t ? $$(t, 'a').map((a) => ({
              name: a.getAttribute('title') || '',
              icon: pickLogo(a) || abs(($(a, 'img') || {}).getAttribute?.('src')),
            })).filter((h) => h.icon) : [];
      const picks1 = heroesOf(thumbs[0]);
      const picks2 = heroesOf(thumbs[1]);
      const sideOf = (t) => {
        if (!t) return null;
        if ($(t, '.brkts-popup-side-color--radiant')) return 'radiant';
        if ($(t, '.brkts-popup-side-color--dire')) return 'dire';
        return null;
      };
      // middle text: "Game N" when unplayed, duration like "36:08" when played
      const midTexts = $$(detail, ':scope > .brkts-popup-spaced')
        .map(txt).filter((t) => t && !/^\s*$/.test(t));
      const mid = midTexts.find((t) => !/thumbs/.test(t)) || '';
      const lt = labels[0] ? labels[0].dataset.labelType : '';
      const rt = labels[labels.length - 1] ? labels[labels.length - 1].dataset.labelType : '';
      let winner = 0;
      if (lt === 'result-win') winner = 1;
      else if (rt === 'result-win') winner = 2;
      const played = /^\d+:\d+$/.test(mid) || winner > 0;
      out.games.push({
        label: played ? '' : mid,
        duration: /^\d+:\d+$/.test(mid) ? mid : '',
        winner,
        played,
        side1: sideOf(thumbs[0]),
        side2: sideOf(thumbs[1]),
        picks1, picks2,
      });
    }

    // footer links (vods, head-to-head, preview...)
    for (const a of $$(popup, '.brkts-popup-footer a[href]')) {
      const img = $(a, 'img');
      const title = a.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '';
      let label = 'Link';
      const href = a.getAttribute('href') || '';
      if (/vod/i.test(title) || /vodlink/.test(a.parentElement.className)) label = 'VOD';
      if (/head-to-head|match history/i.test(title)) label = 'H2H';
      if (/preview/i.test(title)) label = 'Preview';
      if (/interview/i.test(title)) label = 'Interview';
      if (/twitch/i.test(href)) label = 'Stream';
      out.links.push({ href: abs(href), label, title });
    }
    // de-dup by href
    const seen = new Set();
    out.links = out.links.filter((l) => !seen.has(l.href) && seen.add(l.href));
    return out;
  }

  // ------------------------------------------------------------ matchlist
  function parseMatchlists(doc) {
    const matches = [];
    for (const ml of $$(doc, '.brkts-matchlist')) {
      const title = (txt($(ml, '.brkts-matchlist-title')) || 'Matches')
        .replace(/\s*(Show|Hide)\s*/g, ' ').trim();
      for (const m of $$(ml, '.brkts-matchlist-match')) {
        const opps = $$(m, '.brkts-matchlist-opponent');
        const scoreCells = $$(m, '.brkts-matchlist-score');
        const popup = parsePopup($(m, '.brkts-match-info-popup'));
        const t1 = teamFromBlock($(opps[0] || m, '.block-team')) || popup.team1;
        const t2 = teamFromBlock($(opps[1] || m, '.block-team')) || popup.team2;
        const s1 = txt($(scoreCells[0] || m, '.brkts-matchlist-cell-content'));
        const s2 = txt($(scoreCells[1] || m, '.brkts-matchlist-cell-content'));
        const bold1 = (opps[0] || { className: '' }).className.includes('slot-bold') ||
                      (scoreCells[0] || { className: '' }).className.includes('slot-bold');
        const bold2 = (opps[1] || { className: '' }).className.includes('slot-bold') ||
                      (scoreCells[1] || { className: '' }).className.includes('slot-bold');
        const draw = (opps[0] || { className: '' }).className.includes('bg-draw');
        matches.push({
          stage: title,
          team1: t1, team2: t2,
          score1: s1 !== '' ? s1 : null,
          score2: s2 !== '' ? s2 : null,
          winner: draw ? 0 : bold1 && !bold2 ? 1 : bold2 && !bold1 ? 2 : 0,
          draw: draw && s1 !== '',
          ts: popup.ts || null,
          finished: !!popup.finished,
          bestOf: popup.bestOf || (popup.games ? popup.games.length : null),
          games: popup.games || [],
          links: popup.links || [],
          dateText: popup.dateText || '',
        });
      }
    }
    return matches;
  }

  // ------------------------------------------------------------ standings
  function parseGroups(doc) {
    // walk headlines + group tables in document order to label each table
    const groups = [];
    const seq = $$(doc, 'h3, table.grouptable');
    let current = null;
    for (const el of seq) {
      if (el.tagName === 'H3') { current = txt($(el, '.mw-headline') || el).replace(/\[.*\]/, '').trim(); continue; }
      const g = { name: current || `Group ${groups.length + 1}`, rows: [] };
      for (const tr of $$(el, 'tr')) {
        const slot = $(tr, 'td.grouptableslot');
        if (!slot) continue;
        const tds = $$(tr, 'td');
        const promoCell = tds[0];
        const promo = (promoCell.className.match(/bg-(up|stayup|stay|down)/) || [])[1] || '';
        const teamSpan = $(slot, '[data-highlightingclass]');
        const name = teamSpan ? teamSpan.dataset.highlightingclass : txt(slot);
        const rank = txt(promoCell).replace(/\.$/, '');
        const recCells = tds.slice(2).map(txt).filter((t) => /^\d+-\d+(-\d+)?$/.test(t));
        g.rows.push({
          rank: rank || String(g.rows.length + 1),
          promo,
          team: name,
          ...logoPair(slot),
          series: recCells[0] || '',
          games: recCells[1] || '',
        });
      }
      if (g.rows.length) groups.push(g);
    }
    return groups;
  }

  // -------------------------------------------------------------- bracket
  function parseBracketMatch(matchEl, stage) {
    const entries = $$(matchEl, ':scope > .brkts-opponent-entry');
    const popup = parsePopup($(matchEl, '.brkts-match-info-popup'));
    const sides = entries.map((e) => {
      const left = $(e, '.brkts-opponent-entry-left');
      return {
        team: teamFromBlock($(e, '.block-team')),
        score: txt($(e, '.brkts-opponent-score-inner')) || null,
        win: left ? left.className.includes('brkts-opponent-win') : false,
      };
    });
    return {
      stage,
      team1: (sides[0] && sides[0].team) || popup.team1 || { name: null, logo: '' },
      team2: (sides[1] && sides[1].team) || popup.team2 || { name: null, logo: '' },
      score1: sides[0] ? sides[0].score : null,
      score2: sides[1] ? sides[1].score : null,
      winner: sides[0] && sides[0].win ? 1 : sides[1] && sides[1].win ? 2 : 0,
      ts: popup.ts || null,
      finished: !!popup.finished,
      bestOf: popup.bestOf || null,
      games: popup.games || [],
      links: popup.links || [],
      dateText: popup.dateText || '',
    };
  }

  function parseBracket(wrapper, name) {
    const bracket = $(wrapper, '.brkts-bracket');
    if (!bracket) return null;
    // headers may contain multiple responsive alternatives (.brkts-header-option);
    // take the first (longest) option only
    const headers = $$(bracket, ':scope > .brkts-round-header .brkts-header')
      .map((el) => {
        const opt = $(el, '.brkts-header-option');
        return txt(opt || el).split('(')[0].trim();
      });

    const nodes = []; // {depth, order, match, childNodes, qualifies}
    let order = 0;

    function walk(rb, depth) {
      const lower = $(rb, ':scope > .brkts-round-lower');
      const kids = lower ? $$(lower, ':scope > .brkts-round-body') : [];
      const childNodes = kids.map((k) => walk(k, depth + 1));
      const center = $(rb, ':scope > .brkts-round-center');
      const m = center ? $(center, '.brkts-match') : null;
      const node = {
        depth, order: order++,
        match: m ? parseBracketMatch(m, name) : null,
        childNodes,
      };
      const qual = $(rb, ':scope > .brkts-round-qual');
      if (qual) {
        node.qualifies = true;
        node.qualTeam = teamFromBlock($(qual, '.block-team'));
      }
      nodes.push(node);
      return node;
    }

    const rootNodes = $$(bracket, ':scope > .brkts-round-body').map((r) => walk(r, 0));
    const maxDepth = nodes.reduce((mx, n) => Math.max(mx, n.depth), 0);

    // depth 0 = final round; convert to rounds[0] = first round
    const roundCount = maxDepth + 1;
    const rounds = Array.from({ length: roundCount }, () => []);
    nodes.sort((a, b) => a.order - b.order);
    for (const n of nodes) {
      if (!n.match) continue;
      const r = roundCount - 1 - n.depth;
      n.roundIdx = r;
      n.slotIdx = rounds[r].length;
      rounds[r].push(n.match);
    }
    // feeder topology: match.feeders = indices into the previous round
    const qualified = [];
    const quals = []; // {team, fromIndex} — qualification slots fed by final-round matches
    for (const n of nodes) {
      if (!n.match) continue;
      n.match.feeders = n.childNodes
        .filter((c) => c.match && c.roundIdx === n.roundIdx - 1)
        .map((c) => c.slotIdx);
      if (n.qualifies) {
        const team = n.qualTeam || null;
        if (team && team.name) qualified.push(team);
        quals.push({ team, fromIndex: n.slotIdx, fromRound: n.roundIdx });
      }
    }

    // third place match (playoffs)
    let thirdPlace = null;
    const tp = $(wrapper, '.brkts-third-place-match .brkts-match') ||
               $(wrapper.parentElement || wrapper, '.brkts-third-place-match .brkts-match');
    if (tp) thirdPlace = parseBracketMatch(tp, name + ' — 3rd place');

    // round names: headers may include a trailing qualification column
    const roundNames = [];
    for (let i = 0; i < roundCount; i++) roundNames.push(headers[i] || `Round ${i + 1}`);
    const qualHeader = headers.length > roundCount ? headers[headers.length - 1] : null;

    // annotate matches with round name
    rounds.forEach((ms, i) => ms.forEach((m) => (m.round = roundNames[i], m.stage = name)));
    if (thirdPlace) thirdPlace.round = '3rd Place';

    return { name, roundNames, rounds, qualified, quals, qualHeader, thirdPlace };
  }

  function parseBrackets(doc) {
    // label each bracket wrapper with nearest preceding h2 headline
    const out = [];
    const seq = $$(doc, 'h2, .brkts-bracket-wrapper');
    let current = null;
    for (const el of seq) {
      if (el.tagName === 'H2') { current = txt($(el, '.mw-headline') || el).replace(/\[.*?\]/g, '').trim(); continue; }
      const b = parseBracket(el, current || 'Bracket');
      if (b && b.rounds.some((r) => r.length)) out.push(b);
    }
    return out;
  }

  // ---------------------------------------------------------------- teams
  function parseTeams(doc) {
    const teams = [];
    for (const card of $$(doc, '.team-participant-card')) {
      const headerLink = $(card, '.team-participant-card__opponent-compact a[title]') ||
                         $(card, 'a[title]');
      const name = headerLink ? headerLink.getAttribute('title') : txt($(card, '.name'));
      if (!name || teams.some((t) => t.name === name)) continue;
      const roster = [];
      for (const mem of $$(card, '.team-participant-card__member')) {
        const flag = $(mem, '.flag img');
        roster.push({
          name: txt($(mem, '.team-participant-card__member-name .name')) || txt($(mem, '.team-participant-card__member-name')),
          role: txt($(mem, '.team-participant-card__member-role-right')),
          country: flag ? flag.getAttribute('title') || flag.getAttribute('alt') : '',
          flag: flag ? abs(flag.getAttribute('src')) : '',
          trophies: $$(mem, '.team-participant-card__member-trophies i').length,
        });
      }
      const qual = txt($(card, '.team-participant-card__qualifier-details')) ||
                   txt($(card, '.team-participant-card__qualifier-content'));
      teams.push({
        name,
        page: headerLink ? abs(headerLink.getAttribute('href')) : '',
        ...logoPair($(card, '.team-participant-card__opponent-compact') || card),
        roster,
        qualifier: qual,
      });
    }
    return teams;
  }

  // -------------------------------------------------------------- infobox
  function parseInfobox(doc) {
    const box = $(doc, '.fo-nttax-infobox');
    if (!box) return {};
    const info = { fields: {} };
    info.name = txt($(box, '.infobox-header'))
      .replace(/\[e\]\[h\]|\[|\]/g, '').replace(/^eh/, '').trim();
    const img = $(box, '.infobox-image.darkmode img') || $(box, '.infobox-image img');
    if (img) info.logo = abs(img.getAttribute('src'));
    const imgL = $(box, '.infobox-image.lightmode img');
    if (imgL) info.logoL = abs(imgL.getAttribute('src'));
    for (const cell of $$(box, '.infobox-cell-2.infobox-description')) {
      const key = txt(cell).replace(/:$/, '');
      const sib = cell.nextElementSibling;
      let val = '';
      if (sib) {
        // join multi-element values (links, <br>-separated parts) with separators
        val = [...sib.childNodes].map((n) => n.textContent.trim()).filter(Boolean).join(' · ');
        if (!val) val = txt(sib);
      }
      if (key) info.fields[key] = val;
    }
    return info;
  }

  function parseFormatSection(doc) {
    const h = $(doc, 'h2#Format') || $(doc, '#Format');
    if (!h) return '';
    let el = h.closest('.mw-heading') || h;
    const parts = [];
    for (el = el.nextElementSibling; el && !el.matches('.mw-heading2, h2') && parts.length < 6; el = el.nextElementSibling) {
      if (el.matches('ul, p')) {
        const clone = el.cloneNode(true);
        $$(clone, 'sup.reference, .mw-editsection, script, style').forEach((n) => n.remove());
        $$(clone, 'a').forEach((a) => a.replaceWith(...a.childNodes));
        $$(clone, '*').forEach((n) => { [...n.attributes].forEach((at) => n.removeAttribute(at.name)); });
        parts.push(clone.outerHTML);
      }
    }
    return parts.join('');
  }

  function parsePrizes(doc) {
    const table = $(doc, '.prizepooltable');
    if (!table) return [];
    const rows = [];
    for (const row of $$(table, '.csstable-widget-row')) {
      if (row.className.includes('prizepooltable-header')) continue;
      const cells = $$(row, '.csstable-widget-cell').map((c) => ({ el: c, text: txt(c) }));
      if (cells.length < 2) continue;
      const teamCell = cells.find((c) => $(c.el, '.team-template-team-standard, .block-team'));
      rows.push({
        place: (cells[0] || {}).text || '',
        usd: (cells[1] || {}).text || '',
        points: cells.length > 3 ? cells[3].text : '',
        team: teamCell ? (($(teamCell.el, '[data-highlightingclass]') || {}).dataset || {}).highlightingclass || teamCell.text : '',
        ...(teamCell ? logoPair(teamCell.el) : { logo: '', logoL: '' }),
      });
    }
    return rows.filter((r) => /^\d|^[A-Z]/.test(r.place)).slice(0, 12);
  }

  // ------------------------------------------------------------ model
  function buildModel(page, mainHtml, groupHtml) {
    const dp = new DOMParser();
    const main = dp.parseFromString(mainHtml, 'text/html');
    const grp = groupHtml ? dp.parseFromString(groupHtml, 'text/html') : null;

    const info = parseInfobox(main);
    const teams = parseTeams(main);
    const groupsDoc = grp || main;
    const groups = parseGroups(groupsDoc);
    const groupMatches = grp ? parseMatchlists(grp) : parseMatchlists(main);
    const brackets = parseBrackets(main);

    // flatten bracket matches into the global match list
    const bracketMatches = [];
    for (const b of brackets) {
      b.rounds.forEach((round) => round.forEach((m) => bracketMatches.push(m)));
      if (b.thirdPlace) bracketMatches.push(b.thirdPlace);
    }

    const matches = [...groupMatches, ...bracketMatches]
      .filter((m) => m.ts || (m.team1 && m.team1.name) || (m.team2 && m.team2.name));
    matches.sort((a, b) => (a.ts || 9e12) - (b.ts || 9e12));
    matches.forEach((m, i) => (m.id = i));

    return {
      page,
      url: WIKI + '/dota2/' + page.replace(/ /g, '_'),
      fetchedAt: Date.now(),
      info,
      format: parseFormatSection(main),
      prizes: parsePrizes(main),
      teams,
      groups,
      brackets,
      matches,
    };
  }

  // ------------------------------------------------------------ public
  // raw page HTML kept in memory so selective refreshes can rebuild the model
  // by re-fetching only the page that changed
  const htmlMem = {};  // `${src}:${page}` -> {main, group, groupKnown}

  // cached model of any age (for stale-while-revalidate paints)
  function getCached(page, src = 'live') {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey(page, src)));
      if (cached && cached.fetchedAt) return cached;
    } catch (e) { /* ignore */ }
    return null;
  }

  /* opts:
   *   src       'live' | 'local'
   *   force     bypass the TTL model cache (network refresh)
   *   only      'both' | 'main' | 'group' — which wiki page(s) to re-fetch;
   *             the other page is reused from the in-memory HTML cache
   *             (falls back to 'both' when that cache is empty)
   *   onPartial cold-start callback: called with a model built from the main
   *             page only, before the ~2s rate-limit wait + group fetch
   */
  async function loadTournament(page, opts = {}) {
    const src = opts.src || 'live';
    const key = cacheKey(page, src);
    if (!opts.force) {
      const cached = getCached(page, src);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
    }
    const memKey = `${src}:${page}`;
    const mem = htmlMem[memKey] || (htmlMem[memKey] = {});
    const mode = opts.only || 'both';

    const needMain = mode !== 'group' || !mem.main;
    const needGroup = mode !== 'main' || !mem.groupKnown;

    if (needMain) mem.main = await apiFetch(page, { src });
    if (needGroup) {
      // progressive first paint: main page is renderable now, group fetch
      // still has to wait out the request spacing
      if (opts.onPartial && mem.main) {
        try { opts.onPartial(buildModel(page, mem.main, mem.group || null)); }
        catch (e) { console.warn('onPartial failed', e); }
      }
      try { mem.group = await apiFetch(page + '/Group_Stage', { src }); }
      catch (e) { mem.group = null; console.warn('no Group_Stage subpage:', e.message); }
      mem.groupKnown = true;
    }

    const model = buildModel(page, mem.main, mem.group || null);
    try { localStorage.setItem(key, JSON.stringify(model)); }
    catch (e) { console.warn('cache write failed', e); }
    return model;
  }

  return { loadTournament, getCached, CACHE_TTL_MS, WIKI };
})();
