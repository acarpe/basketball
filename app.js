// Referto UISP - PWA single-file app logic
// State persisted in localStorage; events drive all derived stats.

(() => {
  'use strict';

  const STORAGE_KEY = 'uisp-referto-v1';
  const MAX_PERIODS = 4;
  const FOULS_BONUS = 5;            // 5° fallo squadra in periodo => bonus
  const FOULS_OUT = 5;              // 5° fallo individuale => fuori
  const CORS_PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  // ============================================================
  // STATE
  // ============================================================
  /** @type {{match: any}} */
  let state = { match: null };
  let currentTab = 'home';
  let pendingRoster = null;   // parsed roster awaiting confirmation
  let modalPlayer = null;     // {team, number}

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
    pendingRoster = { ...roster, sourceUrl };
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
    preview.classList.remove('hidden');
    preview.scrollIntoView({ behavior: 'smooth' });
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
      item.innerHTML = `
        <span class="badge ${ev.type}">${escapeHtml(badgeText)}</span>
        <div class="desc">
          <div class="team ${ev.team}">${escapeHtml(teamLabel)} · Q${ev.period}</div>
          <div>${escapeHtml(desc)}</div>
        </div>
        <button class="delete" data-id="${ev.id}" aria-label="Elimina">Elimina</button>
      `;
      item.querySelector('.delete').addEventListener('click', () => {
        if (confirm('Eliminare questo evento?')) removeEvent(ev.id);
      });
      list.appendChild(item);
    }
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
      if (state.match) { showScreen('match'); renderMatch(); }
    });
    document.getElementById('btn-discard').addEventListener('click', () => {
      if (confirm('Scartare la partita in corso? I dati saranno persi.')) {
        clearState();
        renderSetup();
      }
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
      if (confirm('Terminare la partita? Tutti i dati saranno cancellati.')) {
        clearState();
        showScreen('setup');
        renderSetup();
      }
    });

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
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    loadState();
    bindEvents();
    if (state.match) {
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
