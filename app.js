// Referto UISP - PWA single-file app logic
// State persisted in localStorage; events drive all derived stats.

(() => {
  'use strict';

  const STORAGE_KEY = 'uisp-referto-v1';
  const RECENT_KEY = 'uisp-referto-recent-v1';
  const MAX_PERIODS = 4;
  const FOULS_BONUS = 5;            // 5° fallo squadra in periodo => bonus
  const FOULS_OUT = 5;              // 5° fallo individuale => fuori
  const CORS_PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];
  const PALETTE = [
    { id: 'blue',   color: '#3b82f6', text: '#ffffff', label: 'Blu' },
    { id: 'red',    color: '#ef4444', text: '#ffffff', label: 'Rosso' },
    { id: 'green',  color: '#22c55e', text: '#ffffff', label: 'Verde' },
    { id: 'yellow', color: '#eab308', text: '#1a1a1a', label: 'Giallo' },
    { id: 'purple', color: '#a855f7', text: '#ffffff', label: 'Viola' },
    { id: 'orange', color: '#f97316', text: '#ffffff', label: 'Arancio' },
    { id: 'black',  color: '#1f2937', text: '#ffffff', label: 'Nero' },
    { id: 'white',  color: '#f3f4f6', text: '#1a1a1a', label: 'Bianco' },
  ];
  const DEFAULT_HOME_COLOR = 'blue';
  const DEFAULT_AWAY_COLOR = 'red';

  // ============================================================
  // STATE
  // ============================================================
  /** @type {{match: any}} */
  let state = { match: null };
  let currentTab = 'home';
  let pendingRoster = null;   // parsed roster awaiting confirmation
  let modalPlayer = null;     // {team, number}
  let editingEventId = null;  // id of event currently being edited

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.match) state = parsed;
    } catch (e) {
      console.warn('Errore caricamento stato:', e);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Errore salvataggio stato:', e);
    }
  }

  function clearState() {
    state = { match: null };
    localStorage.removeItem(STORAGE_KEY);
  }

  function archiveCurrentMatch() {
    if (!state.match) return;
    try {
      const snapshot = {
        savedAt: new Date().toISOString(),
        match: state.match,
      };
      localStorage.setItem(RECENT_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('Errore archiviazione partita:', e);
    }
  }

  function getRecentSnapshot() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.match) return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  function clearRecent() {
    localStorage.removeItem(RECENT_KEY);
  }

  function colorById(id) {
    return PALETTE.find((p) => p.id === id) || PALETTE[0];
  }

  function applyTeamColors() {
    if (!state.match) return;
    const home = colorById(state.match.home.color || DEFAULT_HOME_COLOR);
    const away = colorById(state.match.away.color || DEFAULT_AWAY_COLOR);
    const root = document.documentElement.style;
    root.setProperty('--home', home.color);
    root.setProperty('--home-text', home.text);
    root.setProperty('--away', away.color);
    root.setProperty('--away-text', away.text);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ============================================================
  // PARSING UISP HTML
  // ============================================================
  function parseUispHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Cards with team rosters
    const cards = doc.querySelectorAll('.card.mb-2');
    const teams = [];
    cards.forEach((card) => {
      const titleEl = card.querySelector('.card-title');
      if (!titleEl) return;
      const tbody = card.querySelector('tbody');
      if (!tbody) return;
      const name = (titleEl.textContent || '').trim();
      const players = [];
      let coach = null;
      tbody.querySelectorAll('tr').forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length === 0) return;
        // Skip totals row (bg-dark)
        if (tr.classList.contains('bg-dark')) return;
        const firstSpan = tds[0].querySelector('span');
        const tag = (firstSpan ? firstSpan.textContent : tds[0].textContent || '').trim();
        if (!tag) return;
        // Player row: 6 cells, numeric tag
        if (/^\d+$/.test(tag) && tds.length >= 2) {
          const numEl = tds[1];
          const lastEl = numEl.querySelector('b');
          const smalls = numEl.querySelectorAll('small');
          const lastName = (lastEl ? lastEl.textContent : '').trim();
          const firstName = (smalls[0] ? smalls[0].textContent : '').trim();
          const year = (smalls[1] ? smalls[1].textContent : '').trim();
          players.push({ number: parseInt(tag, 10), lastName, firstName, year });
        } else if (tag === 'ALL' && tds.length >= 2) {
          // Coach
          const lastEl = tds[1].querySelector('b');
          const small = tds[1].querySelector('small');
          coach = {
            lastName: (lastEl ? lastEl.textContent : '').trim(),
            firstName: (small ? small.textContent : '').trim(),
          };
        }
        // DIR rows are silently skipped
      });
      if (name && players.length > 0) {
        teams.push({ name, players, coach });
      }
    });
    if (teams.length < 2) return null;
    return {
      home: teams[0],
      away: teams[1],
    };
  }

  async function fetchViaProxies(url) {
    let lastErr = null;
    for (const buildProxyUrl of CORS_PROXIES) {
      try {
        const resp = await fetch(buildProxyUrl(url), { method: 'GET' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        if (html && html.length > 200) return html;
        throw new Error('Risposta vuota');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Tutti i proxy hanno fallito');
  }

  // ============================================================
  // DERIVED STATS (computed from events)
  // ============================================================
  function getPlayerStats(team, number, period = null) {
    const events = state.match.events;
    let pts = 0, tl = 0, p2 = 0, p3 = 0, fouls = 0;
    for (const ev of events) {
      if (ev.team !== team) continue;
      if (period != null && ev.period !== period) continue;
      if (ev.type === 'score' && ev.number === number) {
        pts += ev.value;
        if (ev.value === 1) tl++;
        else if (ev.value === 2) p2++;
        else if (ev.value === 3) p3++;
      } else if (ev.type === 'foul' && ev.number === number) {
        fouls++;
      }
    }
    return { pts, tl, p2, p3, fouls };
  }

  function getTeamScore(team) {
    let s = 0;
    for (const ev of state.match.events) {
      if (ev.team === team && ev.type === 'score') s += ev.value;
    }
    return s;
  }

  function getTeamFoulsInPeriod(team, period) {
    let n = 0;
    for (const ev of state.match.events) {
      if (ev.team !== team || ev.period !== period) continue;
      if (ev.type === 'foul' || ev.type === 'team_foul') n++;
    }
    return n;
  }

  function getTimeouts(team) {
    let n = 0;
    for (const ev of state.match.events) {
      if (ev.team === team && ev.type === 'timeout') n++;
    }
    return n;
  }

  // ============================================================
  // ACTIONS (mutate events array)
  // ============================================================
  function addEvent(ev) {
    if (!state.match) return;
    state.match.events.push({ id: uid(), ts: Date.now(), ...ev });
    saveState();
    renderMatch();
  }

  function removeEvent(id) {
    if (!state.match) return;
    state.match.events = state.match.events.filter((e) => e.id !== id);
    saveState();
    renderMatch();
    renderHistory();
  }

  function undoLast() {
    if (!state.match || state.match.events.length === 0) return;
    state.match.events.pop();
    saveState();
    renderMatch();
  }

  function setPeriod(p) {
    if (!state.match) return;
    p = Math.max(1, Math.min(MAX_PERIODS, p));
    state.match.currentPeriod = p;
    saveState();
    renderMatch();
  }

  // ============================================================
  // SCREENS
  // ============================================================
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
    const el = document.getElementById('screen-' + name);
    if (el) el.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // ----- SETUP -----
  function renderSetup() {
    const banner = document.getElementById('resume-banner');
    const info = document.getElementById('resume-info');
    if (state.match) {
      const { home, away } = state.match;
      info.textContent = `${home.name} ${getTeamScore('home')} - ${getTeamScore('away')} ${away.name} (Q${state.match.currentPeriod})`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    // Recent match banner
    const recentBanner = document.getElementById('recent-banner');
    const recentInfo = document.getElementById('recent-info');
    const snap = getRecentSnapshot();
    if (snap && snap.match) {
      const m = snap.match;
      const score = (m.events || []).reduce((acc, ev) => {
        if (ev.type === 'score') acc[ev.team] += ev.value;
        return acc;
      }, { home: 0, away: 0 });
      const when = new Date(snap.savedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      recentInfo.textContent = `${m.home.name} ${score.home} - ${score.away} ${m.away.name} · salvata ${when}`;
      recentBanner.classList.remove('hidden');
    } else {
      recentBanner.classList.add('hidden');
    }

    // Init manual roster rows once
    ['home', 'away'].forEach((side) => {
      const c = document.getElementById(`manual-${side}-players`);
      if (!c.dataset.init) {
        for (let i = 0; i < 5; i++) c.appendChild(makeManualRow());
        c.dataset.init = '1';
      }
    });
  }

  function makeManualRow() {
    const row = document.createElement('div');
    row.className = 'player-edit-row';
    row.innerHTML = `
      <input type="number" placeholder="N°" min="0" max="99" inputmode="numeric" />
      <input type="text" placeholder="Cognome" autocomplete="off" />
      <button class="remove" aria-label="Rimuovi">&times;</button>
    `;
    row.querySelector('.remove').addEventListener('click', () => row.remove());
    return row;
  }

  function buildManualRoster() {
    const homeName = document.getElementById('manual-home-name').value.trim() || 'Casa';
    const awayName = document.getElementById('manual-away-name').value.trim() || 'Ospite';
    const collect = (side) => {
      const players = [];
      document.querySelectorAll(`#manual-${side}-players .player-edit-row`).forEach((r) => {
        const inputs = r.querySelectorAll('input');
        const num = parseInt(inputs[0].value, 10);
        const name = inputs[1].value.trim();
        if (!isNaN(num) && name) {
          players.push({ number: num, lastName: name.toUpperCase(), firstName: '', year: '' });
        }
      });
      return players;
    };
    const home = { name: homeName, players: collect('home'), coach: null };
    const away = { name: awayName, players: collect('away'), coach: null };
    if (home.players.length === 0 || away.players.length === 0) return null;
    return { home, away };
  }

  function showPreview(roster, sourceUrl) {
    pendingRoster = {
      home: { ...roster.home, color: roster.home.color || DEFAULT_HOME_COLOR },
      away: { ...roster.away, color: roster.away.color || DEFAULT_AWAY_COLOR },
      sourceUrl,
    };
    const preview = document.getElementById('preview');
    const content = document.getElementById('preview-content');
    content.innerHTML = '';
    ['home', 'away'].forEach((side) => {
      const t = roster[side];
      const div = document.createElement('div');
      div.className = 'preview-team';
      const h = document.createElement('h3');
      h.textContent = `${side === 'home' ? 'Casa' : 'Ospite'}: ${t.name} (${t.players.length} giocatori)`;
      div.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'roster-grid';
      t.players.forEach((p) => {
        const pill = document.createElement('span');
        pill.className = 'pill';
        pill.innerHTML = `<span class="num">${p.number}</span>${escapeHtml(p.lastName)}`;
        grid.appendChild(pill);
      });
      div.appendChild(grid);
      if (t.coach) {
        const c = document.createElement('div');
        c.className = 'muted small mt';
        c.textContent = `All. ${t.coach.lastName} ${t.coach.firstName}`;
        div.appendChild(c);
      }
      content.appendChild(div);
    });
    renderColorPickers();
    preview.classList.remove('hidden');
    preview.scrollIntoView({ behavior: 'smooth' });
  }

  function renderColorPickers() {
    const wrap = document.getElementById('color-pickers');
    if (!pendingRoster) { wrap.innerHTML = ''; return; }
    const sides = [
      { id: 'home', label: 'Casa' },
      { id: 'away', label: 'Ospite' },
    ];
    wrap.innerHTML = sides.map((side) => {
      const team = pendingRoster[side.id];
      const swatches = PALETTE.map((c) => {
        const sel = team.color === c.id ? ' selected' : '';
        return `<button type="button" class="color-swatch${sel}" data-side="${side.id}" data-color-id="${c.id}" style="background:${c.color}" aria-label="${c.label}"></button>`;
      }).join('');
      return `
        <div class="color-picker">
          <div class="color-picker-label">${side.label}<span class="team-name-preview">${escapeHtml(team.name)}</span></div>
          <div class="color-swatches">${swatches}</div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('.color-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = btn.dataset.side;
        pendingRoster[s].color = btn.dataset.colorId;
        renderColorPickers();
      });
    });
  }

  function startMatch() {
    if (!pendingRoster) return;
    state.match = {
      id: uid(),
      sourceUrl: pendingRoster.sourceUrl || null,
      home: pendingRoster.home,
      away: pendingRoster.away,
      events: [],
      currentPeriod: 1,
    };
    pendingRoster = null;
    saveState();
    applyTeamColors();
    currentTab = 'home';
    showScreen('match');
    renderMatch();
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('fetch-status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ----- MATCH -----
  function renderMatch() {
    if (!state.match) {
      showScreen('setup');
      renderSetup();
      return;
    }
    const m = state.match;
    document.getElementById('sb-home-name').textContent = m.home.name;
    document.getElementById('sb-away-name').textContent = m.away.name;
    document.getElementById('sb-home-score').textContent = getTeamScore('home');
    document.getElementById('sb-away-score').textContent = getTeamScore('away');
    document.getElementById('sb-period').textContent = m.currentPeriod;

    ['home', 'away'].forEach((side) => {
      const fouls = getTeamFoulsInPeriod(side, m.currentPeriod);
      const bonusEl = document.getElementById(`sb-${side}-bonus`);
      bonusEl.textContent = fouls >= FOULS_BONUS ? `BONUS (${fouls})` : `Falli sq. ${fouls}`;
      bonusEl.classList.toggle('bonus', fouls >= FOULS_BONUS);
      document.getElementById(`sb-${side}-to`).textContent = `TO ${getTimeouts(side)}`;
    });

    // Tabs
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === currentTab);
    });

    renderPlayers();
  }

  function renderPlayers() {
    const m = state.match;
    const team = m[currentTab];
    const list = document.getElementById('players-list');
    list.dataset.team = currentTab;
    list.innerHTML = '';
    team.players
      .slice()
      .sort((a, b) => a.number - b.number)
      .forEach((p) => {
        const stats = getPlayerStats(currentTab, p.number);
        const card = document.createElement('div');
        const fouledOut = stats.fouls >= FOULS_OUT;
        card.className = 'player-card' + (fouledOut ? ' fouled-out' : '');
        let foulsClass = '';
        if (stats.fouls >= FOULS_OUT) foulsClass = ' out';
        else if (stats.fouls >= FOULS_OUT - 1) foulsClass = ' warn';
        card.innerHTML = `
          <div class="num">${p.number}</div>
          <div class="info">
            <div class="name">${escapeHtml(p.lastName)}</div>
            <div class="first">${escapeHtml(p.firstName)}${p.year ? ' · ' + escapeHtml(p.year) : ''}</div>
            <div class="breakdown">TL ${stats.tl} · 2P ${stats.p2} · 3P ${stats.p3}</div>
          </div>
          <div class="stats">
            <div class="pts">${stats.pts}</div>
            <div class="fouls${foulsClass}">F ${stats.fouls}${fouledOut ? ' OUT' : ''}</div>
          </div>
        `;
        card.addEventListener('click', () => openModal(currentTab, p.number));
        list.appendChild(card);
      });

    if (team.coach) {
      const c = document.createElement('div');
      c.className = 'player-card coach';
      c.innerHTML = `
        <div class="num">All</div>
        <div class="info">
          <div class="name">${escapeHtml(team.coach.lastName)}</div>
          <div class="first">${escapeHtml(team.coach.firstName)}</div>
        </div>
        <div></div>
      `;
      list.appendChild(c);
    }
  }

  // ----- MODAL -----
  function openModal(team, number) {
    modalPlayer = { team, number };
    const t = state.match[team];
    const p = t.players.find((x) => x.number === number);
    if (!p) return;
    const stats = getPlayerStats(team, number);
    document.getElementById('modal-player-label').textContent =
      `#${p.number} ${p.lastName}${p.firstName ? ' ' + p.firstName : ''}`;
    document.getElementById('modal-player-stats').textContent =
      `${stats.pts} pt · TL ${stats.tl} · 2P ${stats.p2} · 3P ${stats.p3} · ${stats.fouls} falli`;
    document.getElementById('modal-action').classList.remove('hidden');
  }

  function closeModal() {
    modalPlayer = null;
    document.getElementById('modal-action').classList.add('hidden');
  }

  function handleModalAction(action, value) {
    if (!modalPlayer) return;
    const { team, number } = modalPlayer;
    const period = state.match.currentPeriod;
    if (action === 'score') {
      addEvent({ type: 'score', team, period, number, value: parseInt(value, 10) });
    } else if (action === 'foul') {
      addEvent({ type: 'foul', team, period, number });
    }
    closeModal();
  }

  // ----- HISTORY -----
  function renderHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (!state.match || state.match.events.length === 0) {
      list.innerHTML = '<div class="history-empty">Nessun evento registrato.</div>';
      return;
    }
    const events = state.match.events.slice().reverse();
    for (const ev of events) {
      const item = document.createElement('div');
      item.className = 'history-item';
      const teamObj = state.match[ev.team];
      const teamLabel = teamObj.name;
      let badgeText = '';
      let desc = '';
      if (ev.type === 'score') {
        badgeText = `+${ev.value}`;
        const p = teamObj.players.find((x) => x.number === ev.number);
        const pname = p ? `#${p.number} ${p.lastName}` : `#${ev.number}`;
        desc = `${pname}`;
      } else if (ev.type === 'foul') {
        badgeText = 'Fallo';
        const p = teamObj.players.find((x) => x.number === ev.number);
        const pname = p ? `#${p.number} ${p.lastName}` : `#${ev.number}`;
        desc = `${pname}`;
      } else if (ev.type === 'team_foul') {
        badgeText = 'F. Sq.';
        desc = 'Fallo di squadra';
      } else if (ev.type === 'timeout') {
        badgeText = 'Timeout';
        desc = 'Sospensione';
      }
      const canEdit = ev.type === 'score' || ev.type === 'foul';
      item.innerHTML = `
        <span class="badge ${ev.type}">${escapeHtml(badgeText)}</span>
        <div class="desc">
          <div class="team ${ev.team}">${escapeHtml(teamLabel)} · Q${ev.period}</div>
          <div>${escapeHtml(desc)}</div>
        </div>
        <div class="actions">
          ${canEdit ? `<button class="edit" data-id="${ev.id}">Modifica</button>` : ''}
          <button class="delete" data-id="${ev.id}">Elimina</button>
        </div>
      `;
      const editBtn = item.querySelector('.edit');
      if (editBtn) editBtn.addEventListener('click', () => openEditEvent(ev.id));
      item.querySelector('.delete').addEventListener('click', () => {
        if (confirm('Eliminare questo evento?')) removeEvent(ev.id);
      });
      list.appendChild(item);
    }
  }

  // ----- EDIT EVENT -----
  function openEditEvent(id) {
    const ev = state.match.events.find((e) => e.id === id);
    if (!ev) return;
    if (ev.type !== 'score' && ev.type !== 'foul') return;
    editingEventId = id;
    renderEditModal();
    document.getElementById('modal-edit').classList.remove('hidden');
  }

  function closeEditModal() {
    editingEventId = null;
    document.getElementById('modal-edit').classList.add('hidden');
  }

  function updateEditedEvent(patch) {
    const ev = state.match.events.find((e) => e.id === editingEventId);
    if (!ev) return;
    Object.assign(ev, patch);
    saveState();
    renderEditModal();
    renderHistory();
    renderMatch();
  }

  function renderEditModal() {
    const ev = state.match.events.find((e) => e.id === editingEventId);
    if (!ev) return;
    document.getElementById('edit-title').textContent =
      ev.type === 'score' ? 'Modifica canestro' : 'Modifica fallo';

    const body = document.getElementById('edit-body');
    const teamObj = state.match[ev.team];
    const players = teamObj.players.slice().sort((a, b) => a.number - b.number);

    let html = '';

    // Team switcher
    html += '<div class="edit-section">';
    html += '<div class="edit-label">Squadra</div>';
    html += '<div class="edit-pills">';
    ['home', 'away'].forEach((t) => {
      const cls = t === ev.team ? 'pill-btn active' : 'pill-btn';
      html += `<button class="${cls}" data-edit-team="${t}">${escapeHtml(state.match[t].name)}</button>`;
    });
    html += '</div></div>';

    // Period switcher
    html += '<div class="edit-section">';
    html += '<div class="edit-label">Quarto</div>';
    html += '<div class="edit-pills">';
    for (let p = 1; p <= MAX_PERIODS; p++) {
      const cls = p === ev.period ? 'pill-btn active' : 'pill-btn';
      html += `<button class="${cls}" data-edit-period="${p}">Q${p}</button>`;
    }
    html += '</div></div>';

    // Value (score only)
    if (ev.type === 'score') {
      html += '<div class="edit-section">';
      html += '<div class="edit-label">Valore</div>';
      html += '<div class="edit-pills">';
      [1, 2, 3].forEach((v) => {
        const cls = v === ev.value ? 'pill-btn active' : 'pill-btn';
        const label = v === 1 ? 'TL +1' : `+${v}`;
        html += `<button class="${cls}" data-edit-value="${v}">${label}</button>`;
      });
      html += '</div></div>';
    }

    // Player picker
    html += '<div class="edit-section">';
    html += '<div class="edit-label">Giocatore</div>';
    if (players.length === 0) {
      html += '<div class="muted small">Nessun giocatore in questa squadra.</div>';
    } else {
      html += '<div class="edit-players">';
      players.forEach((p) => {
        const cls = p.number === ev.number ? 'player-pick active' : 'player-pick';
        html += `<button class="${cls}" data-edit-player="${p.number}">
          <span class="num">${p.number}</span>
          <span class="name">${escapeHtml(p.lastName)}</span>
        </button>`;
      });
      html += '</div>';
    }
    html += '</div>';

    body.innerHTML = html;

    body.querySelectorAll('[data-edit-team]').forEach((b) => {
      b.addEventListener('click', () => updateEditedEvent({ team: b.dataset.editTeam }));
    });
    body.querySelectorAll('[data-edit-period]').forEach((b) => {
      b.addEventListener('click', () => updateEditedEvent({ period: parseInt(b.dataset.editPeriod, 10) }));
    });
    body.querySelectorAll('[data-edit-value]').forEach((b) => {
      b.addEventListener('click', () => updateEditedEvent({ value: parseInt(b.dataset.editValue, 10) }));
    });
    body.querySelectorAll('[data-edit-player]').forEach((b) => {
      b.addEventListener('click', () => updateEditedEvent({ number: parseInt(b.dataset.editPlayer, 10) }));
    });
  }

  // ============================================================
  // SUMMARY (printable / PNG-able)
  // ============================================================
  function renderSummary() {
    const sheet = document.getElementById('summary-sheet');
    if (!state.match) { sheet.innerHTML = ''; return; }
    const m = state.match;
    const home = colorById(m.home.color || DEFAULT_HOME_COLOR);
    const away = colorById(m.away.color || DEFAULT_AWAY_COLOR);

    // Per-period scores
    const periodScores = { home: [0,0,0,0], away: [0,0,0,0] };
    const periodTeamFouls = { home: [0,0,0,0], away: [0,0,0,0] };
    for (const ev of m.events) {
      const idx = (ev.period || 1) - 1;
      if (idx < 0 || idx > 3) continue;
      if (ev.type === 'score') periodScores[ev.team][idx] += ev.value;
      if (ev.type === 'foul' || ev.type === 'team_foul') periodTeamFouls[ev.team][idx]++;
    }
    const totals = {
      home: periodScores.home.reduce((s, v) => s + v, 0),
      away: periodScores.away.reduce((s, v) => s + v, 0),
    };

    const dateStr = new Date().toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });

    const renderTeamTable = (side) => {
      const team = m[side];
      const accent = side === 'home' ? home : away;
      const players = team.players.slice().sort((a, b) => a.number - b.number);
      let teamPts = 0, teamTL = 0, team2 = 0, team3 = 0, teamFouls = 0;
      const rows = players.map((p) => {
        const st = getPlayerStats(side, p.number);
        teamPts += st.pts; teamTL += st.tl; team2 += st.p2; team3 += st.p3; teamFouls += st.fouls;
        const out = st.fouls >= FOULS_OUT;
        return `<tr class="${out ? 'fouled-out' : ''}">
          <td class="num">${p.number}</td>
          <td class="name">${escapeHtml(p.lastName)}${p.firstName ? ' <span class="muted-small" style="color:#888;font-weight:400">' + escapeHtml(p.firstName) + '</span>' : ''}</td>
          <td>${st.tl || '-'}</td>
          <td>${st.p2 || '-'}</td>
          <td>${st.p3 || '-'}</td>
          <td><strong>${st.pts}</strong></td>
          <td>${st.fouls || '-'}</td>
        </tr>`;
      }).join('');

      const totalTeamFoulsAllPeriods = periodTeamFouls[side].reduce((s, v) => s + v, 0);
      const timeouts = getTimeouts(side);

      return `
        <div class="team-block ${side}">
          <div class="team-title" style="color:${accent.color}">
            ${escapeHtml(team.name)}
            <span class="pts">${totals[side]} pt</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th style="text-align:left">Giocatore</th>
                <th>TL</th>
                <th>2P</th>
                <th>3P</th>
                <th>PTI</th>
                <th>F</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="totals">
                <td></td>
                <td class="name">Totali</td>
                <td>${teamTL}</td>
                <td>${team2}</td>
                <td>${team3}</td>
                <td>${teamPts}</td>
                <td>${teamFouls}</td>
              </tr>
            </tbody>
          </table>
          <div class="small-info">
            Timeout: <strong>${timeouts}</strong> ·
            Falli sq. per quarto: ${periodTeamFouls[side].map((v, i) => `Q${i+1} ${v}`).join(' · ')}
            (tot ${totalTeamFoulsAllPeriods})
            ${team.coach ? ' · All. ' + escapeHtml(team.coach.lastName) : ''}
          </div>
        </div>
      `;
    };

    sheet.style.setProperty('--home', home.color);
    sheet.style.setProperty('--away', away.color);

    sheet.innerHTML = `
      <h2>Referto UISP</h2>
      <div class="sub">${escapeHtml(dateStr)}</div>

      <div class="final-score">
        <div class="home">
          <div class="ts-name">${escapeHtml(m.home.name)}</div>
          <div class="ts-score" style="color:${home.color}">${totals.home}</div>
        </div>
        <div class="vs">–</div>
        <div class="away">
          <div class="ts-name">${escapeHtml(m.away.name)}</div>
          <div class="ts-score" style="color:${away.color}">${totals.away}</div>
        </div>
      </div>

      <div class="periods">
        <div class="row-h team">Squadra</div>
        <div class="row-h">Q1</div><div class="row-h">Q2</div><div class="row-h">Q3</div><div class="row-h">Q4</div>
        <div class="row-h">Tot</div>

        <div class="label home">${escapeHtml(m.home.name)}</div>
        ${periodScores.home.map((v) => `<div>${v}</div>`).join('')}
        <div class="row-tot">${totals.home}</div>

        <div class="label away">${escapeHtml(m.away.name)}</div>
        ${periodScores.away.map((v) => `<div>${v}</div>`).join('')}
        <div class="row-tot">${totals.away}</div>
      </div>

      ${renderTeamTable('home')}
      ${renderTeamTable('away')}
    `;
  }

  function printSummary() {
    window.print();
  }

  async function saveSummaryPng() {
    const status = document.getElementById('png-status');
    if (typeof window.html2canvas !== 'function') {
      status.textContent = 'Libreria immagine non caricata. Riprova.';
      status.className = 'status error';
      return;
    }
    const sheet = document.getElementById('summary-sheet');
    if (!sheet || !state.match) return;
    status.textContent = 'Generazione immagine…';
    status.className = 'status info';
    try {
      const canvas = await window.html2canvas(sheet, {
        backgroundColor: '#ffffff',
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
        logging: false,
      });
      canvas.toBlob((blob) => {
        if (!blob) { status.textContent = 'Errore generazione immagine.'; status.className = 'status error'; return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `referto-${safeFilenamePart(state.match.home.name)}-vs-${safeFilenamePart(state.match.away.name)}-${date}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        status.textContent = 'Immagine salvata.';
        status.className = 'status success';
      }, 'image/png');
    } catch (e) {
      console.error(e);
      status.textContent = 'Errore: ' + e.message;
      status.className = 'status error';
    }
  }

  // ============================================================
  // EXPORT / IMPORT
  // ============================================================
  function buildExportPayload(match) {
    return {
      app: 'uisp-referto',
      version: 1,
      exportedAt: new Date().toISOString(),
      match,
    };
  }

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function safeFilenamePart(s) {
    return String(s || '').replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 30);
  }

  function exportMatch(match) {
    if (!match) return;
    const payload = buildExportPayload(match);
    const date = new Date().toISOString().slice(0, 10);
    const fname = `referto-${safeFilenamePart(match.home.name)}-vs-${safeFilenamePart(match.away.name)}-${date}.json`;
    downloadJson(fname, payload);
  }

  function importMatchFromFile(file, onResult) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const match = data && data.match ? data.match : (data && data.events ? data : null);
        if (!match || !match.home || !match.away || !Array.isArray(match.events)) {
          throw new Error('Struttura non valida');
        }
        onResult(null, match);
      } catch (e) {
        onResult(e, null);
      }
    };
    reader.onerror = () => onResult(new Error('Errore lettura file'), null);
    reader.readAsText(file);
  }

  // ============================================================
  // UTILS
  // ============================================================
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ============================================================
  // EVENT BINDING
  // ============================================================
  function bindEvents() {
    // --- Setup ---
    document.getElementById('btn-fetch-url').addEventListener('click', async () => {
      const url = document.getElementById('uisp-url').value.trim();
      if (!url) { setStatus('Inserisci un URL.', 'error'); return; }
      setStatus('Importazione in corso…', 'info');
      try {
        const html = await fetchViaProxies(url);
        const roster = parseUispHtml(html);
        if (!roster) { setStatus('Roster non trovato nella pagina.', 'error'); return; }
        setStatus(`Trovate squadre: ${roster.home.name} vs ${roster.away.name}.`, 'success');
        showPreview(roster, url);
      } catch (e) {
        console.error(e);
        setStatus(
          'Impossibile recuperare la pagina via proxy. Prova "Incolla HTML".',
          'error'
        );
      }
    });

    document.getElementById('btn-toggle-paste').addEventListener('click', () => {
      document.getElementById('paste-area').classList.toggle('hidden');
      document.getElementById('manual-area').classList.add('hidden');
    });
    document.getElementById('btn-toggle-manual').addEventListener('click', () => {
      document.getElementById('manual-area').classList.toggle('hidden');
      document.getElementById('paste-area').classList.add('hidden');
    });

    document.getElementById('btn-parse-paste').addEventListener('click', () => {
      const html = document.getElementById('paste-html').value;
      if (!html.trim()) { setStatus('Incolla l\'HTML completo.', 'error'); return; }
      const roster = parseUispHtml(html);
      if (!roster) { setStatus('Impossibile estrarre il roster da questo HTML.', 'error'); return; }
      const url = document.getElementById('uisp-url').value.trim() || null;
      setStatus(`Trovate squadre: ${roster.home.name} vs ${roster.away.name}.`, 'success');
      showPreview(roster, url);
    });

    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const side = btn.dataset.add;
        document.getElementById(`manual-${side}-players`).appendChild(makeManualRow());
      });
    });

    document.getElementById('btn-manual-create').addEventListener('click', () => {
      const roster = buildManualRoster();
      if (!roster) { setStatus('Inserisci almeno un giocatore per squadra.', 'error'); return; }
      showPreview(roster, null);
    });

    document.getElementById('btn-start-match').addEventListener('click', startMatch);
    document.getElementById('btn-cancel-preview').addEventListener('click', () => {
      pendingRoster = null;
      document.getElementById('preview').classList.add('hidden');
    });

    document.getElementById('btn-resume').addEventListener('click', () => {
      if (state.match) { applyTeamColors(); showScreen('match'); renderMatch(); }
    });
    document.getElementById('btn-discard').addEventListener('click', () => {
      if (confirm('Scartare la partita in corso? Verrà archiviata in "Partita salvata".')) {
        archiveCurrentMatch();
        clearState();
        renderSetup();
      }
    });

    document.getElementById('btn-recover').addEventListener('click', () => {
      const snap = getRecentSnapshot();
      if (!snap || !snap.match) return;
      if (state.match && !confirm('Sostituire la partita corrente con quella salvata?')) return;
      state.match = snap.match;
      saveState();
      applyTeamColors();
      currentTab = 'home';
      showScreen('match');
      renderMatch();
    });

    document.getElementById('btn-export-recent').addEventListener('click', () => {
      const snap = getRecentSnapshot();
      if (snap && snap.match) exportMatch(snap.match);
    });

    document.getElementById('btn-delete-recent').addEventListener('click', () => {
      if (confirm('Eliminare la partita salvata?')) {
        clearRecent();
        renderSetup();
      }
    });

    // --- Import ---
    const importInput = document.getElementById('file-import');
    document.getElementById('btn-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const status = document.getElementById('import-status');
      status.textContent = 'Importazione in corso…';
      status.className = 'status info';
      importMatchFromFile(file, (err, match) => {
        importInput.value = '';
        if (err) {
          status.textContent = 'File non valido: ' + err.message;
          status.className = 'status error';
          return;
        }
        if (state.match && !confirm('Sostituire la partita corrente con quella importata?')) {
          status.textContent = '';
          return;
        }
        state.match = match;
        saveState();
        applyTeamColors();
        currentTab = 'home';
        status.textContent = '';
        showScreen('match');
        renderMatch();
      });
    });

    // --- Match ---
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        currentTab = tab.dataset.tab;
        renderMatch();
      });
    });

    document.getElementById('btn-period-prev').addEventListener('click', () => {
      setPeriod(state.match.currentPeriod - 1);
    });
    document.getElementById('btn-period-next').addEventListener('click', () => {
      setPeriod(state.match.currentPeriod + 1);
    });

    document.getElementById('btn-undo').addEventListener('click', () => {
      if (!state.match || state.match.events.length === 0) return;
      undoLast();
    });

    document.getElementById('btn-history').addEventListener('click', () => {
      renderHistory();
      showScreen('history');
    });

    document.getElementById('btn-team-foul').addEventListener('click', () => {
      addEvent({ type: 'team_foul', team: currentTab, period: state.match.currentPeriod });
    });

    document.getElementById('btn-timeout').addEventListener('click', () => {
      addEvent({ type: 'timeout', team: currentTab, period: state.match.currentPeriod });
    });

    document.getElementById('btn-end-match').addEventListener('click', () => {
      if (confirm('Terminare la partita? Verrà archiviata in "Partita salvata" sulla home.')) {
        archiveCurrentMatch();
        clearState();
        showScreen('setup');
        renderSetup();
      }
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      if (state.match) exportMatch(state.match);
    });

    document.getElementById('btn-summary').addEventListener('click', () => {
      renderSummary();
      showScreen('summary');
    });

    // --- Summary ---
    document.getElementById('btn-summary-back').addEventListener('click', () => {
      showScreen('match');
      renderMatch();
    });
    document.getElementById('btn-print').addEventListener('click', printSummary);
    document.getElementById('btn-png').addEventListener('click', saveSummaryPng);

    // --- History ---
    document.getElementById('btn-history-back').addEventListener('click', () => {
      showScreen('match');
      renderMatch();
    });

    // --- Modal ---
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-action').addEventListener('click', (e) => {
      if (e.target.id === 'modal-action') closeModal();
    });
    document.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        handleModalAction(btn.dataset.action, btn.dataset.value);
      });
    });

    // --- Edit modal ---
    document.getElementById('edit-close').addEventListener('click', closeEditModal);
    document.getElementById('modal-edit').addEventListener('click', (e) => {
      if (e.target.id === 'modal-edit') closeEditModal();
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    loadState();
    bindEvents();
    if (state.match) {
      applyTeamColors();
      showScreen('match');
      renderMatch();
    } else {
      showScreen('setup');
      renderSetup();
    }

    // Register service worker (PWA)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
