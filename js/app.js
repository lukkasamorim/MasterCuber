//  STORAGE
// ═══════════════════════════════════════════════
const APP_VERSION = '1.7.0';
const STORE_KEY   = 'cubetimer_v1';

// ── Configurações (declarado cedo para evitar erros de hoisting) ──
const CFG_KEY = 'cubetimer_cfg';
const CFG_DEFAULTS = {
  sound        : true,
  volume       : 60,
  inspection   : true,
  autoDnf      : true,
  holdTime     : 300,
  showScramble : true,
  showRank     : true,
  timerSize    : 'medium',
  theme        : 'green',
  onlineVisible: true,
  visibleStats : ['count','best','worst','mean','sigma','ao3','ao5','ao12','ao50','ao100'],
  // Personalização avançada (null = usa padrão do tema)
  customTimerColor   : null,
  customScrambleColor: null,
  customBgColor      : null,
  customTextColor    : null,
  customAccentColor  : null,
};
let cfg = (() => {
  try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch(e) { return { ...CFG_DEFAULTS }; }
})();

function storageLoad() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultData();
    return migrateData(JSON.parse(raw));
  } catch(e) { return defaultData(); }
}

function storageSave(data) {
  data.savedAt = new Date().toISOString();
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function defaultData() {
  return { schemaVersion: 1, sessions: { 'Sessão 1': [] }, active: 'Sessão 1' };
}

function migrateData(d) {
  // v0 → v1
  if (!d.schemaVersion) {
    d.schemaVersion = 1;
    if (!d.sessions) d.sessions = { 'Sessão 1': [] };
    if (!d.active)   d.active   = Object.keys(d.sessions)[0];
  }
  // v1 → v2: converte entradas antigas (números puros) para objetos { ms, dnf, scramble }
  if (d.schemaVersion < 2) {
    Object.keys(d.sessions).forEach(name => {
      d.sessions[name] = d.sessions[name].map(entry =>
        typeof entry === 'number'
          ? { ms: entry, dnf: false, scramble: '' }
          : entry
      );
    });
    d.schemaVersion = 2;
  }
  return d;
}

// ═══════════════════════════════════════════════
//  SCRAMBLE
// ═══════════════════════════════════════════════
function genScramble(len = 20) {
  const faces    = ['U','D','R','L','F','B'];
  const mods     = ['', "'", '2'];
  const opposite = { U:'D', D:'U', R:'L', L:'R', F:'B', B:'F' };
  const moves = [];
  let last = null, prev = null;
  while (moves.length < len) {
    const f = faces[Math.floor(Math.random() * 6)];
    if (f === last) continue;
    if (opposite[f] === last && f === prev) continue;
    moves.push(f + mods[Math.floor(Math.random() * 3)]);
    prev = last; last = f;
  }
  return moves.join(' ');
}

// ═══════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════
function fmtTime(ms) {
  if (ms == null || isNaN(ms)) return '—';
  const m  = Math.floor(ms / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const p  = n => String(n).padStart(2, '0');
  return m > 0 ? `${m}:${p(s)}.${p(cs)}` : `${s}.${p(cs)}`;
}

function calcAo(entries, n) {
  if (entries.length < n) return null;
  const slice = entries.slice(-n);
  // DNF conta como tempo, mas não entra na média (é descartado como o pior)
  const sorted = slice.slice().sort((a, b) => {
    if (a.dnf && b.dnf) return 0;
    if (a.dnf) return 1;
    if (b.dnf) return -1;
    return a.ms - b.ms;
  });
  // Remove o melhor e o pior, depois soma só os não-DNF
  const trimmed = sorted.slice(1, -1);
  const validMs = trimmed.filter(e => !e.dnf).map(e => e.ms);
  if (validMs.length < trimmed.length) return null; // DNF no meio → média inválida
  return validMs.reduce((a, b) => a + b, 0) / validMs.length;
}

function computeStats(entries) {
  if (!entries.length) return { count:0, best:'—', worst:'—', mean:'—', ao3:'—', ao5:'—', ao12:'—', ao50:'—', ao100:'—', sigma:'—', bestRaw: null };
  const validMs = entries.filter(e => !e.dnf).map(e => e.ms);
  const best  = validMs.length ? Math.min(...validMs) : null;
  const worst = validMs.length ? Math.max(...validMs) : null;
  const mean  = validMs.length ? validMs.reduce((a,b) => a+b, 0) / validMs.length : null;
  const sigma = (validMs.length > 1 && mean != null)
    ? Math.sqrt(validMs.reduce((acc, t) => acc + Math.pow(t - mean, 2), 0) / validMs.length)
    : null;
  return {
    count:  entries.length,
    best:   best  != null ? fmtTime(best)  : 'DNF',
    worst:  worst != null ? fmtTime(worst) : 'DNF',
    mean:   mean  != null ? fmtTime(mean)  : 'DNF',
    ao3:    fmtTime(calcAo(entries, 3)),
    ao5:    fmtTime(calcAo(entries, 5)),
    ao12:   fmtTime(calcAo(entries, 12)),
    ao50:   fmtTime(calcAo(entries, 50)),
    ao100:  fmtTime(calcAo(entries, 100)),
    sigma:  sigma != null ? fmtTime(Math.round(sigma)) : '—',
    bestRaw: best,
  };
}

// ═══════════════════════════════════════════════
//  APP STATE
// ═══════════════════════════════════════════════
let data = storageLoad();

// Timer state machine
// idle → (hold) → inspection → (hold) → running → idle
const STATE = { IDLE:'idle', HOLDING:'holding', READY:'ready', INSPECTION:'inspection', RUNNING:'running' };
let timerState = STATE.IDLE;
let startTime  = 0;
let rafId      = null;
let holdTimer  = null;
let inspTimer  = null;
let inspLeft   = 15;
let isReady    = false;
let cameFromInspection = false;

// ── DOM refs ──
const elTimer    = document.getElementById('timer');
const elHint     = document.getElementById('hint');
const elScramble = document.getElementById('scramble');
const elHistory  = document.getElementById('history');
const elSession  = document.getElementById('sel-session');
const elToast    = document.getElementById('toast');

// ═══════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════
function currentTimes() {
  return data.sessions[data.active] || [];
}

function renderSession() {
  elSession.innerHTML = '';
  Object.keys(data.sessions).forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    if (name === data.active) o.selected = true;
    elSession.appendChild(o);
  });
}

function renderStats() {
  const s = computeStats(currentTimes());
  document.getElementById('s-count').textContent = s.count;
  document.getElementById('s-best').textContent  = s.best;
  document.getElementById('s-worst').textContent = s.worst;
  document.getElementById('s-mean').textContent  = s.mean;
  document.getElementById('s-ao3').textContent   = s.ao3;
  document.getElementById('s-ao5').textContent   = s.ao5;
  document.getElementById('s-ao12').textContent  = s.ao12;
  document.getElementById('s-ao50').textContent  = s.ao50;
  document.getElementById('s-ao100').textContent = s.ao100;
  document.getElementById('s-sigma').textContent = s.sigma;
}

function renderHistory() {
  const entries = currentTimes();
  if (!entries.length) {
    elHistory.innerHTML = '<div class="history-empty">Nenhum tempo ainda</div>';
    return;
  }

  const validMs = entries.filter(e => !e.dnf).map(e => e.ms);
  const bestVal = validMs.length ? Math.min(...validMs) : null;
  const total   = entries.length;

  // Cabeçalho com resumo
  const validCount = validMs.length;
  const meanMs     = validMs.length ? validMs.reduce((a,b)=>a+b,0)/validMs.length : null;
  const summary    = `resolvendo: ${validCount}/${total} &nbsp;·&nbsp; média: ${meanMs ? fmtTime(Math.round(meanMs)) : '—'}`;

  const rows = entries.slice().reverse().map((e, ri) => {
    const idx   = total - ri;
    const isPB  = !e.dnf && e.ms === bestVal;

    // ao5 e ao12 para esta posição
    const slice5  = entries.slice(0, idx);
    const slice12 = entries.slice(0, idx);
    const ao5val  = calcAo(slice5,  5);
    const ao12val = calcAo(slice12, 12);

    const timeCell = e.dnf
      ? `<td class="td-time dnf" onclick="openSolveDetail(${idx-1})">DNF</td>`
      : `<td class="td-time ${isPB ? 'pb' : ''}" onclick="openSolveDetail(${idx-1})">${fmtTime(e.ms)}</td>`;

    const ao5Cell  = ao5val  != null ? `<td class="td-ao">${fmtTime(Math.round(ao5val))}</td>`  : `<td class="td-ao" style="color:var(--muted)">—</td>`;
    const ao12Cell = ao12val != null ? `<td class="td-ao">${fmtTime(Math.round(ao12val))}</td>` : `<td class="td-ao" style="color:var(--muted)">—</td>`;

    return `<tr>
      <td>#${idx}</td>
      ${timeCell}
      ${ao5Cell}
      ${ao12Cell}
      <td><button class="hi-del" onclick="deleteTime(${idx-1})">✕</button></td>
    </tr>`;
  }).join('');

  elHistory.innerHTML = `
    <div style="font-family:var(--mono);font-size:11px;color:var(--muted);text-align:center;padding:8px 4px;border-bottom:1px solid var(--border);">${summary}</div>
    <table class="history-table">
      <thead>
        <tr>
          <th>#</th>
          <th>tempo</th>
          <th>ao5</th>
          <th>ao12</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function newScramble() {
  elScramble.textContent = genScramble();
  updateScramblePreview();
}

function renderAll() {
  renderSession();
  renderStats();
  renderHistory();
}

// ═══════════════════════════════════════════════
//  AUDIO — BIP DE INSPEÇÃO
// ═══════════════════════════════════════════════
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBip(freq = 880, duration = 0.12, volume = 0.3) {
  if (typeof cfg !== 'undefined' && !cfg.sound) return;
  const vol = typeof cfg !== 'undefined' ? volume * (cfg.volume / 100) : volume;
  try {
    const ctx = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch(e) {}
}

// Bip duplo (aviso de 8s)
function playDoubleBip() {
  playBip(880, 0.1, 0.3);
  setTimeout(() => playBip(880, 0.1, 0.3), 160);
}

// Bip triplo grave (aviso de 12s — mais urgente)
function playTripleBip() {
  playBip(660, 0.1, 0.4);
  setTimeout(() => playBip(660, 0.1, 0.4), 150);
  setTimeout(() => playBip(660, 0.1, 0.4), 300);
}
function showPenalties(show) {
  // O card de penalidades permanece visível; no foco ele some junto com os painéis laterais.
  document.getElementById('card-penalties').style.display = 'block';
}

function setTimerState(s) {
  timerState = s;
  elTimer.className = 'timer-display ' + s;
}

const hintText = {
  idle:       'segure <kbd>espaço</kbd> para iniciar &nbsp;·&nbsp; ou aperte <kbd>espaço</kbd> para inspecionar',
  holding:    'continue segurando...',
  ready:      'pode soltar!',
  inspection: 'aperte <kbd>espaço</kbd> para iniciar a solve',
  running:    'aperte <kbd>espaço</kbd> para finalizar',
};

function setHint(s) { elHint.innerHTML = hintText[s] || ''; }

function startRunning() {
  clearInterval(inspTimer);
  clearTimeout(holdTimer);
  elTimer.style.color = '';
  elTimer.style.animation = '';
  setTimerState(STATE.RUNNING);
  setHint('running');
  startTime = Date.now();
  function tick() {
    elTimer.textContent = fmtTime(Date.now() - startTime);
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function startInspection() {
  inspLeft = 0;
  setTimerState(STATE.INSPECTION);
  setHint('inspection');
  elTimer.textContent = '0';
  elTimer.style.color = '';
  inspTimer = setInterval(() => {
    inspLeft++;
    elTimer.textContent = inspLeft;

    // Avisos visuais por tempo
    if (inspLeft >= 15) {
      elTimer.style.color = 'var(--danger)';
      elTimer.style.animation = 'inspFlash .4s ease infinite';
    } else if (inspLeft >= 12) {
      elTimer.style.color = '#f5c800';
      elTimer.style.animation = 'inspPulse .6s ease infinite';
    } else {
      elTimer.style.color = 'var(--warning)';
      elTimer.style.animation = '';
    }

    // Bips nos marcos
    if (inspLeft === 8)  playDoubleBip();
    if (inspLeft === 12) playTripleBip();

    if (inspLeft >= 15) {
      clearInterval(inspTimer);
      elTimer.style.color = '';
      elTimer.style.animation = '';
      if (cfg?.autoDnf !== false) {
        // DNF automático
        setTimerState(STATE.IDLE);
        setHint('idle');
        elTimer.innerHTML = '<span style="color:var(--danger)">DNF</span>';
        const scramble = elScramble.textContent || '';
        data.sessions[data.active].push({ ms: 0, dnf: true, scramble });
        storageSave(data);
        renderAll();
        updateRankWidget();
        newScramble();
        showToast('Tempo esgotado — DNF registrado.');
      } else {
        // Sem DNF automático — apenas para a inspeção e inicia o timer
        startRunning();
      }
    }
  }, 1000);
}

function setFocusMode(on) {
  document.querySelector('.layout').classList.toggle('focus-mode', on);
  document.querySelector('.header').style.opacity = on ? '0' : '1';
  document.querySelector('.header').style.pointerEvents = on ? 'none' : '';
  const preview = document.getElementById('scramble-preview');
  if (preview) { preview.style.opacity = on ? '0' : '1'; preview.style.pointerEvents = on ? 'none' : ''; }
}

function pressDown() {
  if (timerState === STATE.RUNNING) {
    cancelAnimationFrame(rafId);
    const t = Date.now() - startTime;
    setTimerState(STATE.IDLE);
    setHint('idle');
    elTimer.textContent = fmtTime(t);
    setFocusMode(false);
    saveTime(t);
    return;
  }
  if (timerState === STATE.IDLE) {
    isReady = false;
    cameFromInspection = false;
    setTimerState(STATE.HOLDING);
    setHint('holding');
    setFocusMode(true);
    showPenalties(false);
    holdTimer = setTimeout(() => {
      isReady = true;
      setTimerState(STATE.READY);
      setHint('ready');
    }, cfg?.holdTime || 300);
  }
  if (timerState === STATE.INSPECTION) {
    isReady = false;
    cameFromInspection = true;
    // Não para o inspTimer — inspeção continua correndo
    setTimerState(STATE.HOLDING);
    setHint('holding');
    setFocusMode(true);
    holdTimer = setTimeout(() => {
      isReady = true;
      setTimerState(STATE.READY);
      setHint('ready');
    }, cfg?.holdTime || 300);
  }
}

function pressUp() {
  clearTimeout(holdTimer);
  if (timerState === STATE.HOLDING || timerState === STATE.READY) {
    if (isReady) {
      startRunning();
    } else if (cameFromInspection) {
      startRunning();
    } else {
      if (cfg?.inspection === false) {
        startRunning();
      } else {
        setTimerState(STATE.IDLE);
        setFocusMode(false);
        startInspection();
      }
    }
  }
}

function cancelTimer() {
  if (timerState === STATE.IDLE) return;
  clearTimeout(holdTimer);
  clearInterval(inspTimer);
  cancelAnimationFrame(rafId);
  setTimerState(STATE.IDLE);
  setHint('idle');
  elTimer.textContent = '0.00';
  setFocusMode(false);
  showToast('Cancelado.');
}

function saveTime(t) {
  const scramble = elScramble.textContent || '';
  data.sessions[data.active].push({ ms: t, dnf: false, scramble });
  storageSave(data);
  renderAll();
  newScramble();
  showToast('Salvo: ' + fmtTime(t));
  updateRankWidget();
  showPenalties(true);
}

function applyPlus2() {
  const entries = data.sessions[data.active];
  if (!entries.length) return;
  entries[entries.length - 1].ms += 2000;
  entries[entries.length - 1].plus2 = true;
  storageSave(data);
  renderAll();
  updateRankWidget();
  elTimer.textContent = fmtTime(entries[entries.length - 1].ms);
  showPenalties(false);
  showToast('+2 aplicado.');
}

function applyDNF() {
  const entries = data.sessions[data.active];
  if (!entries.length) return;
  entries[entries.length - 1].dnf = true;
  storageSave(data);
  renderAll();
  updateRankWidget();
  elTimer.innerHTML = '<span style="color:var(--danger)">DNF</span>';
  showPenalties(false);
  showToast('DNF registrado.');
}

function deleteTime(i) {
  data.sessions[data.active].splice(i, 1);
  storageSave(data);
  renderAll();
  updateRankWidget();
}

// ── Modal de detalhes da solve ──
let solveDetailIdx = null;

function openSolveDetail(i) {
  const entries = data.sessions[data.active];
  const e = entries[i];
  if (!e) return;
  solveDetailIdx = i;

  const validMs = entries.filter(x => !x.dnf).map(x => x.ms);
  const bestVal = validMs.length ? Math.min(...validMs) : null;
  const isPB    = !e.dnf && e.ms === bestVal;

  // Título
  document.getElementById('solve-detail-title').textContent = `Solve #${i + 1}`;

  // Tempo
  const timeEl = document.getElementById('solve-detail-time');
  if (e.dnf) {
    timeEl.textContent  = 'DNF';
    timeEl.className    = 'solve-detail-time dnf-label';
  } else {
    timeEl.textContent  = fmtTime(e.ms);
    timeEl.className    = 'solve-detail-time' + (isPB ? ' pb-label' : '');
  }

  // Tags de status
  const tagsEl = document.getElementById('solve-detail-tags');
  const tags = [];
  if (e.dnf)  tags.push('<span class="solve-tag tag-dnf">DNF</span>');
  if (e.plus2) tags.push('<span class="solve-tag tag-p2">+2</span>');
  if (isPB)   tags.push('<span class="solve-tag tag-pb">🏆 PB</span>');
  if (!e.dnf && !e.plus2 && !isPB) tags.push('<span class="solve-tag tag-ok">OK</span>');
  tagsEl.innerHTML = tags.join('');

  // Scramble
  document.getElementById('solve-detail-scramble').textContent = e.scramble || '(scramble não disponível)';

  document.getElementById('solve-detail-overlay').style.display = 'flex';
}

function closeSolveDetail() {
  document.getElementById('solve-detail-overlay').style.display = 'none';
  solveDetailIdx = null;
}

function copySolve() {
  if (solveDetailIdx === null) return;
  const entries = data.sessions[data.active];
  const e = entries[solveDetailIdx];
  if (!e) return;

  const time    = e.dnf ? 'DNF' : fmtTime(e.ms) + (e.plus2 ? ' (+2)' : '');
  const scramble = e.scramble || '(scramble não disponível)';
  const text    = `Solve #${solveDetailIdx + 1}\nTempo: ${time}\nScramble: ${scramble}`;

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy-solve');
    btn.textContent = '✓ Copiado!';
    btn.style.color = 'var(--accent)';
    btn.style.borderColor = 'rgba(212,242,68,.4)';
    setTimeout(() => {
      btn.textContent = '📋 Copiar';
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 2000);
  }).catch(() => showToast('Erro ao copiar.'));
}

function reapplyScramble() {
  const entries = data.sessions[data.active];
  const e = solveDetailIdx !== null ? entries[solveDetailIdx] : null;
  if (!e || !e.scramble) return;
  elScramble.textContent = e.scramble;
  updateScramblePreview();
  closeSolveDetail();
  showToast('Scramble aplicado!');
}

function deleteSolveFromDetail() {
  if (solveDetailIdx === null) return;
  closeSolveDetail();
  deleteTime(solveDetailIdx);
}

// ═══════════════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════════════

// Teclado timer principal
function timerKeyDown(e) {
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); pressDown(); }
  if (e.code === 'Escape') { cancelTimer(); }
}
function timerKeyUp(e) {
  if (e.code === 'Space') { e.preventDefault(); pressUp(); }
}

// Touch no display do timer
elTimer.addEventListener('touchstart', e => { e.preventDefault(); pressDown(); }, { passive: false });
elTimer.addEventListener('touchend',   e => { e.preventDefault(); pressUp(); },   { passive: false });

// Novo scramble
document.getElementById('btn-scramble').addEventListener('click', newScramble);

// Sessões
elSession.addEventListener('change', () => {
  data.active = elSession.value;
  storageSave(data);
  renderStats();
  renderHistory();
});

document.getElementById('btn-new-session').addEventListener('click', () => {
  openSessionNameModal('new');
});

document.getElementById('btn-rename-session').addEventListener('click', () => {
  openSessionNameModal('rename');
});

let sessionNameModalMode = null; // 'new' | 'rename'
let sessionNameOriginal = '';

function openSessionNameModal(mode) {
  const overlay = document.getElementById('session-name-overlay');
  const title = document.getElementById('session-name-title');
  const input = document.getElementById('session-name-input');
  const help = document.getElementById('session-name-help');
  const confirmBtn = document.getElementById('btn-confirm-session-name');

  if (mode === 'rename') {
    const currentName = data.active;
    if (!currentName || !data.sessions[currentName]) return;
    sessionNameOriginal = currentName;
    sessionNameModalMode = 'rename';
    title.textContent = 'Renomear sessão';
    help.textContent = `Nome atual: "${currentName}"`;
    confirmBtn.textContent = 'Renomear';
    input.value = currentName;
  } else {
    sessionNameOriginal = '';
    sessionNameModalMode = 'new';
    title.textContent = 'Nova sessão';
    help.textContent = 'Escolha um nome para criar uma nova sessão.';
    confirmBtn.textContent = 'Criar sessão';
    input.value = '';
  }

  overlay.style.display = 'flex';
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeSessionNameModal() {
  document.getElementById('session-name-overlay').style.display = 'none';
  sessionNameModalMode = null;
  sessionNameOriginal = '';
}

function confirmSessionNameModal() {
  const input = document.getElementById('session-name-input');
  const name = input.value.trim();

  if (!name) {
    showToast('Digite um nome válido para a sessão.');
    input.focus();
    return;
  }

  if (sessionNameModalMode === 'new') {
    if (data.sessions[name]) {
      showToast('Sessão já existe.');
      input.focus();
      input.select();
      return;
    }
    data.sessions[name] = [];
    data.active = name;
    storageSave(data);
    renderAll();
    closeSessionNameModal();
    showToast(`Sessão "${name}" criada.`);
    return;
  }

  if (sessionNameModalMode === 'rename') {
    if (!sessionNameOriginal || !data.sessions[sessionNameOriginal]) {
      closeSessionNameModal();
      return;
    }
    if (name === sessionNameOriginal) {
      closeSessionNameModal();
      return;
    }
    if (data.sessions[name]) {
      showToast('Já existe uma sessão com esse nome.');
      input.focus();
      input.select();
      return;
    }
    data.sessions[name] = data.sessions[sessionNameOriginal];
    delete data.sessions[sessionNameOriginal];
    data.active = name;
    storageSave(data);
    renderAll();
    closeSessionNameModal();
    showToast(`Sessão renomeada para "${name}".`);
  }
}

document.getElementById('session-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmSessionNameModal();
  }
});

document.getElementById('btn-clear').addEventListener('click', () => {
  const count = data.sessions[data.active].length;
  document.getElementById('clear-session-name').textContent = `"${data.active}"`;
  document.getElementById('clear-session-count').textContent =
    count === 0 ? 'nenhum tempo'
    : count === 1 ? '1 tempo'
    : `${count} tempos`;
  document.getElementById('clear-session-overlay').style.display = 'flex';
});

function closeClearSession() {
  document.getElementById('clear-session-overlay').style.display = 'none';
}

function confirmClearSession() {
  data.sessions[data.active] = [];
  storageSave(data);
  closeClearSession();
  renderAll();
  showToast('Sessão limpa.');
}

document.getElementById('btn-delete-session').addEventListener('click', () => {
  const sessions = Object.keys(data.sessions);
  if (sessions.length <= 1) {
    showToast('Não é possível excluir a única sessão.');
    return;
  }
  const count = data.sessions[data.active].length;
  document.getElementById('delete-session-name').textContent = `"${data.active}"`;
  document.getElementById('delete-session-count').textContent =
    count === 0 ? 'nenhum tempo'
    : count === 1 ? '1 tempo'
    : `${count} tempos`;
  document.getElementById('delete-session-overlay').style.display = 'flex';
});

function closeDeleteSession() {
  document.getElementById('delete-session-overlay').style.display = 'none';
}

function confirmDeleteSession() {
  const name = data.active;
  const sessions = Object.keys(data.sessions);
  // Ativa a sessão anterior ou próxima
  const idx = sessions.indexOf(name);
  const nextActive = sessions[idx > 0 ? idx - 1 : 1];
  delete data.sessions[name];
  data.active = nextActive;
  storageSave(data);
  closeDeleteSession();
  renderAll();
  updateRankWidget();
  showToast(`Sessão "${name}" excluída.`);
}

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
let toastTimer = null;
function showToast(msg) {
  elToast.textContent = msg;
  elToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.remove('show'), 2000);
}

// ═══════════════════════════════════════════════
//  PÁGINA APRENDER — TRILHA ESTILO DUOLINGO
// ═══════════════════════════════════════════════

const TRAIL = [
  {
    section: 'PRINCÍPIOS DO CUBO',
    nodes: [
      {
        id: 'mov-basicos', icon: '🔄', label: 'Movimentos Básicos',
        title: 'Movimentos Básicos',
        desc: 'As notações podem ser no sentido horário ou anti-horário. Quando são no sentido anti-horário são seguidas por \' (apóstrofo). Seguidas de 2 significam meia volta (180°).',
        type: 'moves',
        moves: [
          { name: 'R',  alg: 'R',  desc: 'Face direita — horário' },
          { name: "R'", alg: "R'", desc: 'Face direita — anti-horário' },
          { name: 'R2', alg: 'R2', desc: 'Face direita — meia volta' },
          { name: 'L',  alg: 'L',  desc: 'Face esquerda — horário' },
          { name: "L'", alg: "L'", desc: 'Face esquerda — anti-horário' },
          { name: 'L2', alg: 'L2', desc: 'Face esquerda — meia volta' },
          { name: 'U',  alg: 'U',  desc: 'Face de cima — horário' },
          { name: "U'", alg: "U'", desc: 'Face de cima — anti-horário' },
          { name: 'U2', alg: 'U2', desc: 'Face de cima — meia volta' },
          { name: 'D',  alg: 'D',  desc: 'Face de baixo — horário' },
          { name: "D'", alg: "D'", desc: 'Face de baixo — anti-horário' },
          { name: 'D2', alg: 'D2', desc: 'Face de baixo — meia volta' },
          { name: 'F',  alg: 'F',  desc: 'Face frontal — horário' },
          { name: "F'", alg: "F'", desc: 'Face frontal — anti-horário' },
          { name: 'F2', alg: 'F2', desc: 'Face frontal — meia volta' },
          { name: 'B',  alg: 'B',  desc: 'Face traseira — horário' },
          { name: "B'", alg: "B'", desc: 'Face traseira — anti-horário' },
          { name: 'B2', alg: 'B2', desc: 'Face traseira — meia volta' },
        ]
      },
      {
        id: 'mov-duplos', icon: '⚡', label: 'Movimentos Duplos',
        title: 'Movimentos Duplos',
        desc: 'Movimentos de 2 camadas e wide moves são usados principalmente no CFOP avançado e em outros métodos como Roux.',
        cards: [
          { icon: '📐', title: 'Wide moves (minúsculo)', text: "Letras minúsculas (r, l, u...) indicam um wide move: move a face E a camada do meio juntas. Equivale a mover 2 camadas ao mesmo tempo.", alg: "r = R + M' (wide R)\nl = L + M  (wide L)", tip: '<strong>Quando usar:</strong> Principalmente no F2L avançado e nas últimas camadas do CFOP.' },
          { icon: '🔁', title: 'Movimentos do meio (M, E, S)', text: 'M, E e S movem apenas a camada do meio sem mover nenhuma face. M segue a direção de L, E segue D, e S segue F.', alg: "M  = camada do meio (dir. de L)\nE  = camada equatorial (dir. de D)\nS  = camada frontal do meio (dir. de F)", tip: null },
        ]
      },
      {
        id: 'mov-rotacao', icon: '🌀', label: 'Rotações',
        title: 'Rotações do Cubo Inteiro',
        desc: 'Rotações movem o cubo inteiro sem embaralhar nada. São usadas para reposicionar o cubo durante a resolução.',
        cards: [
          { icon: '🔃', title: 'x, y, z', text: 'x gira o cubo inteiro no sentido de R. y gira no sentido de U. z gira no sentido de F. Com apóstrofo, sentido inverso. Com 2, meia volta.', alg: "x  = cubo inteiro sentido de R\ny  = cubo inteiro sentido de U\nz  = cubo inteiro sentido de F", tip: null },
          { icon: '⚠️', title: 'Minimize rotações', text: 'Cada rotação é tempo perdido. Speedcubers tentam fazer o F2L inteiro sem rotacionar o cubo, usando look-ahead e reorientação mental.', alg: null, tip: '<strong>Meta:</strong> Resolver o F2L com zero ou apenas uma rotação por slot.' },
        ]
      },
    ]
  },
  {
    section: 'MÉTODO INICIANTE',
    nodes: [
      {
        id: 'ini-cruz', icon: '✚', label: 'Cruz Branca',
        title: 'Passo 1 — Cruz Branca',
        desc: 'O método iniciante começa montando uma cruz branca na face branca, com cada aresta alinhada com a cor da face lateral.',
        cards: [
          { icon: '🎯', title: 'O objetivo', text: 'Montar 4 arestas brancas na face inferior (branca), cada uma alinhada com o centro da sua face lateral correspondente.', alg: null, tip: '<strong>Dica:</strong> Não há algoritmo fixo aqui — observe onde cada aresta está e leve ela para o lugar.' },
          { icon: '📍', title: 'Estratégia para iniciantes', text: 'Comece pela aresta branco-verde, depois branco-vermelho, branco-azul e branco-laranja. Resolva uma de cada vez sem preocupar com as outras.', alg: null, tip: null },
          { icon: '✅', title: 'Como verificar', text: 'Com o branco embaixo: a face de baixo forma uma cruz branca E cada aresta lateral está alinhada com o centro da mesma cor.', alg: null, tip: '<strong>Erro comum:</strong> Cruz formada mas arestas laterais erradas. Sempre verifique os dois lados da aresta.' },
        ]
      },
      {
        id: 'ini-cantos', icon: '🟡', label: 'Cantos Brancos',
        title: 'Passo 2 — Cantos Brancos',
        desc: 'Com a cruz pronta, agora insira os 4 cantos brancos para completar a primeira camada.',
        cards: [
          { icon: '🔍', title: 'Encontre o canto certo', text: 'Cada canto tem 3 cores. O canto branco-vermelho-verde vai entre as faces branca, vermelha e verde. Localize o canto na camada de cima.', alg: null, tip: null },
          { icon: '⚙️', title: 'Algoritmo de inserção', text: 'Posicione o canto acima do slot onde ele deve ir (canto superior direito da face frontal) e execute:', alg: "R U R' U' (repita até encaixar)\n\nSe o canto está no lugar mas mal orientado:\nF' U' F (insere pelo lado esquerdo)", tip: '<strong>Dica:</strong> O algoritmo R U R\' U\' pode precisar ser repetido 1 a 5 vezes dependendo da orientação.' },
        ]
      },
      {
        id: 'ini-f2l', icon: '🧩', label: 'Segunda Camada',
        title: 'Passo 3 — Segunda Camada',
        desc: 'Com a primeira camada completa, insira as 4 arestas da segunda camada (as que não têm amarelo).',
        cards: [
          { icon: '🔎', title: 'Identifique as arestas', text: 'As arestas da segunda camada têm 2 cores, nenhuma delas amarela. Ex: vermelho-verde, vermelho-azul, laranja-verde, laranja-azul.', alg: null, tip: null },
          { icon: '➡️', title: 'Inserir para a direita', text: 'Posicione a aresta no topo alinhada com seu centro frontal e execute:', alg: "U R U' R' U' F' U F   (insere à direita)", tip: null },
          { icon: '⬅️', title: 'Inserir para a esquerda', text: 'Se a aresta precisa ir para a esquerda do slot:', alg: "U' L' U L U F U' F'   (insere à esquerda)", tip: '<strong>Dica:</strong> Se a aresta está no lugar mas errada, execute um dos algoritmos acima para tirá-la primeiro.' },
        ]
      },
      {
        id: 'ini-oll', icon: '🌟', label: 'Cruz Amarela',
        title: 'Passo 4 — Cruz Amarela (OLL básico)',
        desc: 'Com as duas primeiras camadas prontas, forme a cruz amarela na face do topo.',
        cards: [
          { icon: '🔍', title: 'Identifique o padrão', text: 'Olhe para cima. Você vai ver um de 4 padrões: ponto, L, linha, ou cruz já formada.', alg: null, tip: null },
          { icon: '⚙️', title: 'Algoritmo da cruz', text: 'Se você vê um ponto, execute 3 vezes. Se vê um L, posicione o L no canto superior esquerdo e execute 2 vezes. Se vê uma linha, posicione horizontal e execute 1 vez:', alg: "F R U R' U' F'", tip: '<strong>Dica:</strong> Sempre que o padrão não for cruz, execute este algoritmo e reavalie.' },
        ]
      },
      {
        id: 'ini-pll', icon: '🏆', label: 'Última Camada',
        title: 'Passos 5, 6 e 7 — Última Camada',
        desc: 'Oriente e permute os cantos e arestas da última camada para terminar o cubo.',
        cards: [
          { icon: '🔄', title: 'Passo 5: Orientar cantos amarelos', text: 'Com a cruz amarela feita, oriente os 4 cantos para o amarelo ficar para cima. Execute até o canto estar correto, depois gire U para o próximo (nunca gire o cubo inteiro).', alg: "R U R' U R U2 R'   (Sune — orienta cantos)", tip: '<strong>IMPORTANTE:</strong> Nunca gire o cubo durante este algoritmo. Só gire a face U.' },
          { icon: '🔀', title: 'Passo 6: Permutar cantos', text: 'Com todos amarelos para cima, posicione os cantos nos lugares certos (mesmo que virados). Encontre dois cantos no lugar correto e posicione-os na face de trás:', alg: "R' F R' B2 R F' R' B2 R2", tip: null },
          { icon: '✨', title: 'Passo 7: Permutar arestas', text: 'Por último, permute as arestas da última camada. Gire U para alinhar uma aresta e execute:', alg: "F2 U L R' F2 L' R U F2   (ciclo de arestas)\n\nAo final, ajuste com U, U' ou U2", tip: '<strong>Parabéns!</strong> Se você chegou até aqui, você sabe resolver o cubo mágico!' },
        ]
      },
    ]
  },
  {
    section: 'MÉTODO CFOP',
    nodes: [
      {
        id: 'cfop-cross', icon: '➕', label: 'Cross',
        title: 'CFOP — Cross (Cruz)',
        desc: 'No CFOP a cruz é resolvida intuitivamente, sem algoritmo fixo, idealmente em 4 a 8 movimentos.',
        cards: [
          { icon: '🧠', title: 'Cruz intuitiva', text: 'Diferente do método iniciante, no CFOP você planeja a cruz inteira durante a inspeção de 15 segundos, visualizando os movimentos antes de tocar o cubo.', alg: null, tip: '<strong>Meta:</strong> Cruz em até 8 movimentos. Profissionais fazem em 4-6.' },
          { icon: '🔭', title: 'Cruz na face D (baixo)', text: 'No CFOP a cruz é resolvida com a face branca para baixo (D). Isso permite já visualizar os slots do F2L enquanto monta a cruz.', alg: null, tip: '<strong>Dica:</strong> Pratique a cruz separadamente. Embaralhe só as 4 arestas brancas e resolva repetidamente.' },
          { icon: '📐', title: 'Planejamento na inspeção', text: 'Use os 15 segundos de inspeção para planejar a cruz completa. Com treino, você consegue planejar os 8 movimentos antes mesmo de começar.', alg: null, tip: null },
        ]
      },
      {
        id: 'cfop-f2l', icon: '🧱', label: 'F2L',
        title: 'CFOP — F2L (Primeiras 2 Camadas)',
        desc: 'O F2L resolve canto e aresta ao mesmo tempo em cada um dos 4 slots. É o passo mais impactante no tempo.',
        cards: [
          { icon: '🤝', title: 'O conceito de par', text: 'Para cada slot, você une o canto (3 cores) com a aresta (2 cores) formando um par na camada U, e insere os dois juntos.', alg: null, tip: '<strong>Dica:</strong> Nunca insira canto e aresta separados — sempre forme o par primeiro.' },
          { icon: '📘', title: 'Caso básico — par formado', text: 'Quando canto e aresta já estão unidos na camada U prontos para entrar:', alg: "Inserir à direita: U R U' R'\nInserir à esquerda: U' L' U L", tip: null },
          { icon: '👁️', title: 'Look-Ahead', text: 'É a habilidade de localizar o próximo par enquanto ainda está resolvendo o atual. É o que elimina as pausas entre slots.', alg: null, tip: '<strong>Treino:</strong> Resolva em câmera lenta forçando os olhos a procurarem o próximo par durante o atual.' },
          { icon: '📊', title: 'Os 41 casos de F2L', text: 'Existem 41 casos diferentes de F2L. Iniciantes aprendem os casos básicos intuitivamente. Com o tempo, memorize os casos mais eficientes para cada situação.', alg: null, tip: '<strong>Meta:</strong> F2L completo em menos de 25 segundos.' },
        ]
      },
      {
        id: 'cfop-oll', icon: '🟡', label: 'OLL',
        title: 'CFOP — OLL (Orientação da Última Camada)',
        desc: 'O OLL orienta todas as peças da última camada para a face superior ficar completamente amarela. 57 casos no total.',
        cards: [
          { icon: '🎓', title: '2-Look OLL (recomendado para iniciantes)', text: 'Divide o OLL em 2 etapas: Cruz amarela (3 algoritmos) + Orientação dos cantos (7 algoritmos). Total de ~9 algs para aprender.', alg: null, tip: '<strong>Recomendação:</strong> Comece pelo 2-Look OLL. Aprenda o OLL completo quando seu tempo chegar a ~30s.' },
          { icon: '✚', title: '2-Look Etapa 1: Cruz amarela', text: 'Se não há arestas amarelas no topo, use o alg abaixo. Repita identificando o padrão (ponto → 3x, L → 2x, linha → 1x):', alg: "F R U R' U' F'", tip: null },
          { icon: '🔆', title: '2-Look Etapa 2: Orientar cantos', text: 'Com a cruz feita, oriente os cantos. O Sune e Anti-Sune cobrem a maioria dos casos:', alg: "Sune:      R U R' U R U2 R'\nAnti-Sune: R' U' R U' R' U2 R", tip: '<strong>Dica:</strong> Os outros 5 casos do 2-Look OLL são combinações de Sune/Anti-Sune.' },
        ]
      },
      {
        id: 'cfop-pll', icon: '🏁', label: 'PLL',
        title: 'CFOP — PLL (Permutação da Última Camada)',
        desc: 'O PLL permuta as peças da última camada já orientadas. 21 casos. O 2-Look PLL usa apenas 6 algoritmos.',
        cards: [
          { icon: '🎯', title: '2-Look PLL: comece aqui', text: 'Etapa 1: permuta os cantos (2 algoritmos). Etapa 2: permuta as arestas (4 algoritmos). Total: 6 algs para resolver qualquer PLL em 2 passos.', alg: null, tip: null },
          { icon: '📐', title: 'Passo 1: Permutar cantos', text: 'Procure 2 cantos adjacentes com a mesma cor frontal. Posicione-os na frente e execute:', alg: "Adj: x R' U R' D2 R U' R' D2 R2\nDiag: R U' R D2 R' U R D2 R2", tip: '<strong>Dica:</strong> Se nenhum par bate, execute qualquer um primeiro.' },
          { icon: '🔁', title: 'Passo 2: Permutar arestas', text: 'Com os cantos no lugar, permute as arestas. Ua e Ub são os mais comuns:', alg: "Ua: R U' R U R U R U' R' U' R2\nUb: R2 U R U R' U' R' U' R' U R'\nH:  M2 U M2 U2 M2 U M2\nZ:  M2 U M2 U M' U2 M2 U2 M'", tip: null },
          { icon: '⏱️', title: 'AUF — Ajuste final', text: 'Após o PLL, o cubo pode estar resolvido mas a camada U desalinhada. Use U, U\' ou U2 para alinhar. Isso é o AUF (Adjust U Face).', alg: "U  /  U'  /  U2", tip: '<strong>Parabéns!</strong> Você agora conhece o CFOP completo — o método dos maiores speedcubers do mundo.' },
        ]
      },
    ]
  }
];

let activeLesson = null;
let activeSection = null;
let completedLessons = new Set(JSON.parse(localStorage.getItem('ct_completed') || '[]'));

function saveCompleted() {
  localStorage.setItem('ct_completed', JSON.stringify([...completedLessons]));
}

// Ícone e descrição de cada seção
const SECTION_META = {
  'PRINCÍPIOS DO CUBO':  { icon: '🧊', sub: 'Movimentos, rotações e notação' },
  'MÉTODO INICIANTE':    { icon: '🟢', sub: 'Resolva o cubo passo a passo' },
  'MÉTODO CFOP':         { icon: '⚡', sub: 'Cross · F2L · OLL · PLL' },
};

// Renderiza a tela inicial da trilha (blocos de seção)
function renderTrailOverview() {
  const el = document.getElementById('trail-overview-inner');
  el.innerHTML = TRAIL.map((section, si) => {
    const meta  = SECTION_META[section.section] || { icon: '📘', sub: '' };
    const isPrincipio = section.section === 'PRINCÍPIOS DO CUBO';

    const nodes = section.nodes.map(n => {
      const done = completedLessons.has(n.id);
      return `<div class="sbn ${done ? 'done' : ''}">
        <span class="sbn-icon">${n.icon}</span>
        <span class="sbn-label">${n.label}</span>
        ${done ? '<span style="color:var(--accent);font-size:11px">✓</span>' : ''}
      </div>`;
    }).join('');

    if (isPrincipio) {
      return `<div class="section-block section-block-hero" onclick="openSection('${section.section}')">
        <div class="section-hero-content">
          <div class="section-hero-icon">${meta.icon}</div>
          <div class="section-hero-text">
            <div class="section-hero-label">COMECE AQUI</div>
            <div class="section-hero-name">${section.section}</div>
            <div class="section-hero-sub">${meta.sub}</div>
          </div>
          <span class="section-block-arrow" style="font-size:24px">→</span>
        </div>
      </div>`;
    }

    return `<div class="section-block" onclick="openSection('${section.section}')">
      <div class="section-block-header">
        <div class="section-block-left">
          <span class="section-block-icon">${meta.icon}</span>
          <div>
            <div class="section-block-name">${section.section}</div>
            <div class="section-block-sub">${meta.sub}</div>
          </div>
        </div>
        <span class="section-block-arrow">→</span>
      </div>
      <div class="section-block-nodes">${nodes}</div>
    </div>`;
  }).join('');
}

// Abre a vista interna de uma seção
function openSection(sectionName) {
  activeSection = sectionName;
  document.getElementById('trail-overview').style.display = 'none';
  document.getElementById('lesson-view').style.display    = 'flex';
  document.getElementById('lesson-view-title').textContent = sectionName;

  // Filtra só os nós desta seção
  const section = TRAIL.find(s => s.section === sectionName);
  renderTrailNodes(section);

  // Abre a primeira lição automaticamente
  if (section && section.nodes.length) openLesson(section.nodes[0].id);
}

function backToTrail() {
  activeLesson  = null;
  activeSection = null;
  document.getElementById('lesson-view').style.display    = 'none';
  document.getElementById('trail-overview').style.display = 'block';
  renderTrailOverview();
}

// Renderiza os nós da trilha lateral (dentro da seção aberta)
function renderTrailNodes(section) {
  const col = document.getElementById('trail-col');
  if (!section) { col.innerHTML = ''; return; }

  const nodes = section.nodes.map((node, ni) => {
    const isDone   = completedLessons.has(node.id);
    const isActive = activeLesson === node.id;
    const connector = ni < section.nodes.length - 1
      ? `<div class="trail-connector ${isDone ? 'done' : ''}"></div>` : '';
    return `<div class="trail-node-wrap">
      <div class="trail-node ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}"
           onclick="openLesson('${node.id}')" title="${node.title}">
        <div class="trail-node-icon">${node.icon}</div>
        <div class="trail-node-check">✓</div>
      </div>
      <div class="trail-node-label">${node.label}</div>
      ${connector}
    </div>`;
  }).join('');

  col.innerHTML = `<div class="trail-section">
    <span class="trail-section-label">${section.section}</span>
    <div class="trail">${nodes}</div>
  </div>`;
}


// ═══════════════════════════════════════════════
//  SCRAMBLE PREVIEW — SIMULADOR + NET SVG
// ═══════════════════════════════════════════════

// Estado inicial resolvido: U=branco, D=amarelo, F=verde, B=azul, R=vermelho, L=laranja
function solvedState() {
  const face = c => Array.from({length:3}, () => Array(3).fill(c));
  return {
    U: face('W'), D: face('Y'), F: face('G'),
    B: face('B'), R: face('R'), L: face('O'),
  };
}

function cloneState(s) {
  const n = {};
  for (const f of 'UDFBRL') n[f] = s[f].map(r => [...r]);
  return n;
}

// Gira face CW (visto de fora)
function rotateFaceCW(f) {
  return [
    [f[2][0], f[1][0], f[0][0]],
    [f[2][1], f[1][1], f[0][1]],
    [f[2][2], f[1][2], f[0][2]],
  ];
}
function rotateFaceCCW(f) { return rotateFaceCW(rotateFaceCW(rotateFaceCW(f))); }
function rotateFace180(f) { return rotateFaceCW(rotateFaceCW(f)); }

// Ciclo de 4 aristas/arestas em arrays lineares
function cycle4(a0,i0, a1,i1, a2,i2, a3,i3, n) {
  const tmp = a3.map((_,k) => a3[i3(k)]);
  for(let k=0;k<n;k++) a3[i3(k)] = a2[i2(k)];
  for(let k=0;k<n;k++) a2[i2(k)] = a1[i1(k)];
  for(let k=0;k<n;k++) a1[i1(k)] = a0[i0(k)];
  for(let k=0;k<n;k++) a0[i0(k)] = tmp[k];
}

// Helpers para extrair/inserir linhas e colunas
function getRow(f,r)    { return [...f[r]]; }
function getCol(f,c)    { return [f[0][c],f[1][c],f[2][c]]; }
function setRow(f,r,v)  { for(let i=0;i<3;i++) f[r][i]=v[i]; }
function setCol(f,c,v)  { for(let i=0;i<3;i++) f[i][c]=v[i]; }
function rev(a)         { return [...a].reverse(); }

// Aplicar um único movimento ao estado
function applyMove(s, move) {
  const n = cloneState(s);
  const {U,D,F,B,R,L} = n;
  switch(move) {
    case 'U': {
      n.U = rotateFaceCW(U);
      const t = getRow(F,0); setRow(n.F,0,getRow(R,0)); setRow(n.R,0,getRow(B,0)); setRow(n.B,0,getRow(L,0)); setRow(n.L,0,t); break;
    }
    case "U'": {
      n.U = rotateFaceCCW(U);
      const t = getRow(F,0); setRow(n.F,0,getRow(L,0)); setRow(n.L,0,getRow(B,0)); setRow(n.B,0,getRow(R,0)); setRow(n.R,0,t); break;
    }
    case 'U2': return applyMove(applyMove(s,'U'),'U');

    case 'D': {
      n.D = rotateFaceCW(D);
      const t = getRow(F,2); setRow(n.F,2,getRow(L,2)); setRow(n.L,2,getRow(B,2)); setRow(n.B,2,getRow(R,2)); setRow(n.R,2,t); break;
    }
    case "D'": {
      n.D = rotateFaceCCW(D);
      const t = getRow(F,2); setRow(n.F,2,getRow(R,2)); setRow(n.R,2,getRow(B,2)); setRow(n.B,2,getRow(L,2)); setRow(n.L,2,t); break;
    }
    case 'D2': return applyMove(applyMove(s,'D'),'D');

    case 'R': {
      n.R = rotateFaceCW(R);
      const t = getCol(U,2);
      setCol(n.U,2,getCol(F,2));
      setCol(n.F,2,getCol(D,2));
      setCol(n.D,2,rev(getCol(B,0)));
      setCol(n.B,0,rev(t));
      break;
    }
    case "R'": {
      n.R = rotateFaceCCW(R);
      const t = getCol(U,2);
      setCol(n.U,2,rev(getCol(B,0)));
      setCol(n.B,0,rev(getCol(D,2)));
      setCol(n.D,2,getCol(F,2));
      setCol(n.F,2,t);
      break;
    }
    case 'R2': return applyMove(applyMove(s,'R'),'R');

    case 'L': {
      n.L = rotateFaceCW(L);
      const t = getCol(U,0);
      setCol(n.U,0,rev(getCol(B,2)));
      setCol(n.B,2,rev(getCol(D,0)));
      setCol(n.D,0,getCol(F,0));
      setCol(n.F,0,t);
      break;
    }
    case "L'": {
      n.L = rotateFaceCCW(L);
      const t = getCol(U,0);
      setCol(n.U,0,getCol(F,0));
      setCol(n.F,0,getCol(D,0));
      setCol(n.D,0,rev(getCol(B,2)));
      setCol(n.B,2,rev(t));
      break;
    }
    case 'L2': return applyMove(applyMove(s,'L'),'L');

    case 'F': {
      n.F = rotateFaceCW(F);
      const t = getRow(U,2);
      setRow(n.U,2,rev(getCol(L,2)));
      setCol(n.L,2,getRow(D,0));
      setRow(n.D,0,rev(getCol(R,0)));
      setCol(n.R,0,t);
      break;
    }
    case "F'": {
      n.F = rotateFaceCCW(F);
      const t = getRow(U,2);
      setRow(n.U,2,getCol(R,0));
      setCol(n.R,0,rev(getRow(D,0)));
      setRow(n.D,0,getCol(L,2));
      setCol(n.L,2,rev(t));
      break;
    }
    case 'F2': return applyMove(applyMove(s,'F'),'F');

    case 'B': {
      n.B = rotateFaceCW(B);
      const t = getRow(U,0);
      setRow(n.U,0,getCol(R,2));
      setCol(n.R,2,rev(getRow(D,2)));
      setRow(n.D,2,getCol(L,0));
      setCol(n.L,0,rev(t));
      break;
    }
    case "B'": {
      n.B = rotateFaceCCW(B);
      const t = getRow(U,0);
      setRow(n.U,0,rev(getCol(L,0)));
      setCol(n.L,0,getRow(D,2));
      setRow(n.D,2,rev(getCol(R,2)));
      setCol(n.R,2,t);
      break;
    }
    case 'B2': return applyMove(applyMove(s,'B'),'B');
  }
  return n;
}

// Aplica sequência de movimentos
function applyScramble(scramble) {
  const moves = scramble.trim().split(/\s+/).filter(Boolean);
  let state = solvedState();
  for (const m of moves) state = applyMove(state, m);
  return state;
}

// Cores das faces para o SVG
const NET_COLORS = {
  W: '#f0ede6', Y: '#f5c800', G: '#22b14c',
  B: '#0066cc', R: '#e8362a', O: '#ff8c00',
};

// Renderiza a "net" (planificação) do cubo em SVG
// Layout padrão WCA:
//       [U]
//  [L] [F] [R] [B]
//       [D]
function renderScrambleNet(state) {
  const S = 16;   // tamanho de cada quadradinho
  const G = 1.5;  // gap entre cubículos
  const P = 6;    // padding da face
  const FS = 3 * S + 2 * G; // tamanho de cada face

  const totalW = 4 * FS + 3 * P + 8;
  const totalH = 3 * FS + 2 * P + 8;

  // Posição (col, row) de cada face na net (em unidades de face)
  const facePos = {
    U: { col: 1, row: 0 },
    L: { col: 0, row: 1 },
    F: { col: 1, row: 1 },
    R: { col: 2, row: 1 },
    B: { col: 3, row: 1 },
    D: { col: 1, row: 2 },
  };

  function drawFace(faceData, ox, oy) {
    let out = '';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const color = NET_COLORS[faceData[r][c]] || '#888';
        const x = ox + c * (S + G);
        const y = oy + r * (S + G);
        out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${S}" height="${S}" rx="2" fill="${color}" stroke="#00000033" stroke-width="0.5"/>`;
      }
    }
    return out;
  }

  let faces = '';
  for (const [name, pos] of Object.entries(facePos)) {
    const ox = 4 + pos.col * (FS + P);
    const oy = 4 + pos.row * (FS + P);
    faces += drawFace(state[name], ox, oy);
    // Label da face
    const lx = ox + FS/2;
    const ly = oy - 3;
    faces += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="7" fill="#6b6860" font-family="monospace">${name}</text>`;
  }

  return `<svg viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg" style="display:block">${faces}</svg>`;
}

// Toggle de visibilidade da prévia
function toggleScramblePreview() {
  const preview = document.getElementById('scramble-preview');
  const btnShow = document.getElementById('btn-show-preview');
  const isHidden = preview.classList.toggle('hidden');
  localStorage.setItem('ct_preview_hidden', isHidden ? '1' : '0');
  if (btnShow) btnShow.style.display = isHidden ? 'inline-flex' : 'none';
}

function initScramblePreviewState() {
  const hidden = localStorage.getItem('ct_preview_hidden') === '1';
  const preview = document.getElementById('scramble-preview');
  const btnShow = document.getElementById('btn-show-preview');
  if (hidden) {
    preview.classList.add('hidden');
    if (btnShow) btnShow.style.display = 'inline-flex';
  }
}

// Atualiza o widget sempre que o scramble mudar
function updateScramblePreview() {
  const scramble = elScramble.textContent.trim();
  const net = document.getElementById('scramble-net');
  if (!net) return;
  if (!scramble) { net.innerHTML = ''; return; }
  try {
    const state = applyScramble(scramble);
    net.innerHTML = renderScrambleNet(state);
  } catch(e) {
    net.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════
//  SVG CUBOS — 18 movimentos básicos
// ═══════════════════════════════════════════════

// Cores padrão
const CL = { W:'#f0ede6', Y:'#f5c800', R:'#e8362a', O:'#ff8c00', G:'#22b14c', B:'#0066cc', K:'#1a1a1a' };

// Desenha um cubo isométrico 3x3 com faces U (topo), R (direita), F (frente)
// u/r/f = arrays 3x3 de cores
function drawCube(u, r, f) {
  const W = 160, H = 140;
  // Projeção isométrica: origem centro-baixo
  const ox = 80, oy = 78;
  const sx = 20, sy = 11; // tamanho de cada célula

  // Converte coordenadas de grade iso para pixel
  function iso(gx, gy, gz) {
    return [
      ox + (gx - gy) * sx,
      oy - gz * sy * 2 + (gx + gy) * sy
    ];
  }

  function cell(pts, color) {
    const d = pts.map(([x,y]) => `${x},${y}`).join(' ');
    const dark = shadeColor(color, -18);
    return `<polygon points="${d}" fill="${color}" stroke="${dark}" stroke-width="1.2" stroke-linejoin="round"/>`;
  }

  function shadeColor(hex, amt) {
    let r = parseInt(hex.slice(1,3),16)+amt;
    let g = parseInt(hex.slice(3,5),16)+amt;
    let b = parseInt(hex.slice(5,7),16)+amt;
    r = Math.max(0,Math.min(255,r));
    g = Math.max(0,Math.min(255,g));
    b = Math.max(0,Math.min(255,b));
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;

  // Face U (topo) — grid [row][col], row=0 é frente, col=0 é esquerda
  for (let row = 2; row >= 0; row--) {
    for (let col = 0; col < 3; col++) {
      const c = u[row][col];
      const [x0,y0] = iso(col,   row,   3);
      const [x1,y1] = iso(col+1, row,   3);
      const [x2,y2] = iso(col+1, row+1, 3);
      const [x3,y3] = iso(col,   row+1, 3);
      svg += cell([[x0,y0],[x1,y1],[x2,y2],[x3,y3]], c);
    }
  }

  // Face F (frente) — row=0 é topo, col=0 é esquerda
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const c = f[row][col];
      const gz = 2 - row;
      const [x0,y0] = iso(col,   3, gz+1);
      const [x1,y1] = iso(col+1, 3, gz+1);
      const [x2,y2] = iso(col+1, 3, gz);
      const [x3,y3] = iso(col,   3, gz);
      svg += cell([[x0,y0],[x1,y1],[x2,y2],[x3,y3]], c);
    }
  }

  // Face R (direita) — row=0 é topo, col=0 é frente
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const c = r[row][col];
      const gz = 2 - row;
      const gy = 2 - col;
      const [x0,y0] = iso(3, gy+1, gz+1);
      const [x1,y1] = iso(3, gy,   gz+1);
      const [x2,y2] = iso(3, gy,   gz);
      const [x3,y3] = iso(3, gy+1, gz);
      svg += cell([[x0,y0],[x1,y1],[x2,y2],[x3,y3]], c);
    }
  }

  svg += '</svg>';
  return svg;
}

// Estado resolvido
const S = {
  U: [[CL.W,CL.W,CL.W],[CL.W,CL.W,CL.W],[CL.W,CL.W,CL.W]],
  F: [[CL.G,CL.G,CL.G],[CL.G,CL.G,CL.G],[CL.G,CL.G,CL.G]],
  R: [[CL.R,CL.R,CL.R],[CL.R,CL.R,CL.R],[CL.R,CL.R,CL.R]],
  B: [[CL.B,CL.B,CL.B],[CL.B,CL.B,CL.B],[CL.B,CL.B,CL.B]],
  L: [[CL.O,CL.O,CL.O],[CL.O,CL.O,CL.O],[CL.O,CL.O,CL.O]],
  D: [[CL.Y,CL.Y,CL.Y],[CL.Y,CL.Y,CL.Y],[CL.Y,CL.Y,CL.Y]],
};

function rot90CW(m)  { return [[m[2][0],m[1][0],m[0][0]],[m[2][1],m[1][1],m[0][1]],[m[2][2],m[1][2],m[0][2]]]; }
function rot90CCW(m) { return [[m[0][2],m[1][2],m[2][2]],[m[0][1],m[1][1],m[2][1]],[m[0][0],m[1][0],m[2][0]]]; }
function rot180(m)   { return rot90CW(rot90CW(m)); }
function clone(m)    { return m.map(r => [...r]); }

// Aplica movimento R: gira face R, permuta colunas de U,F,D,B
function applyR(u, r, f, show_r, show_f, show_u) {
  const nu = clone(u), nr = rot90CW(r), nf = clone(f);
  // col 2 de U ← col 2 de F
  for (let i=0;i<3;i++) { nu[i][2]=f[i][2]; }
  // col 2 de F ← col 2 de D (amarelo)
  for (let i=0;i<3;i++) { nf[i][2]=CL.Y; }
  return { u:nu, r:nr, f:nf };
}

// Estados pré-calculados para cada movimento
function getCubeSVGForMove(move) {
  let u = clone(S.U), r = clone(S.R), f = clone(S.F);

  switch(move) {
    // ── R ──
    case 'R': {
      // Face R gira CW, col direita: U←F, F←D(Y), mas mostramos estado após
      const nu = clone(u), nf = clone(f), nr = rot90CW(r);
      for(let i=0;i<3;i++) { nu[i][2]=CL.G; } // U col2 ← verde (era frente)
      for(let i=0;i<3;i++) { nf[i][2]=CL.Y; } // F col2 ← amarelo (era baixo)
      return drawCube(nu, nr, nf);
    }
    case "R'": {
      const nu = clone(u), nf = clone(f), nr = rot90CCW(r);
      for(let i=0;i<3;i++) { nu[i][2]=CL.Y; } // U col2 ← amarelo
      for(let i=0;i<3;i++) { nf[i][2]=CL.W; } // F col2 ← branco
      return drawCube(nu, nr, nf);
    }
    case 'R2': {
      const nu = clone(u), nf = clone(f), nr = rot180(r);
      for(let i=0;i<3;i++) { nu[i][2]=CL.Y; }
      for(let i=0;i<3;i++) { nf[i][2]=CL.W; }
      return drawCube(nu, nr, nf);
    }

    // ── L ──
    case 'L': {
      // L usa face esquerda, mostramos F e U afetados na col 0
      const nu = clone(u), nf = clone(f), nr = clone(r);
      for(let i=0;i<3;i++) { nu[i][0]=CL.Y; }
      for(let i=0;i<3;i++) { nf[i][0]=CL.W; }
      return drawCube(nu, nr, nf);
    }
    case "L'": {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      for(let i=0;i<3;i++) { nu[i][0]=CL.G; }
      for(let i=0;i<3;i++) { nf[i][0]=CL.Y; }
      return drawCube(nu, nr, nf);
    }
    case 'L2': {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      for(let i=0;i<3;i++) { nu[i][0]=CL.Y; }
      for(let i=0;i<3;i++) { nf[i][0]=CL.W; }
      return drawCube(nu, nr, nf);
    }

    // ── U ──
    case 'U': {
      // Topo gira CW: F row0 ← R col (via U)
      const nu = rot90CW(u), nf = clone(f), nr = clone(r);
      nf[0] = [CL.R,CL.R,CL.R]; // frente topo ← vermelho (era direita)
      nr[0] = [CL.B,CL.B,CL.B]; // direita topo ← azul (era trás)
      return drawCube(nu, nr, nf);
    }
    case "U'": {
      const nu = rot90CCW(u), nf = clone(f), nr = clone(r);
      nf[0] = [CL.O,CL.O,CL.O];
      nr[0] = [CL.G,CL.G,CL.G];
      return drawCube(nu, nr, nf);
    }
    case 'U2': {
      const nu = rot180(u), nf = clone(f), nr = clone(r);
      nf[0] = [CL.B,CL.B,CL.B];
      nr[0] = [CL.G,CL.G,CL.G];
      return drawCube(nu, nr, nf);
    }

    // ── D ──
    case 'D': {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nf[2] = [CL.O,CL.O,CL.O];
      nr[2] = [CL.G,CL.G,CL.G];
      return drawCube(nu, nr, nf);
    }
    case "D'": {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nf[2] = [CL.R,CL.R,CL.R];
      nr[2] = [CL.B,CL.B,CL.B];
      return drawCube(nu, nr, nf);
    }
    case 'D2': {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nf[2] = [CL.B,CL.B,CL.B];
      nr[2] = [CL.O,CL.O,CL.O];
      return drawCube(nu, nr, nf);
    }

    // ── F ──
    case 'F': {
      const nu = clone(u), nf = rot90CW(f), nr = clone(r);
      nu[2] = [CL.O,CL.O,CL.O]; // base do topo ← laranja
      for(let i=0;i<3;i++) { nr[i][0]=CL.W; } // col esq da direita ← branco
      return drawCube(nu, nr, nf);
    }
    case "F'": {
      const nu = clone(u), nf = rot90CCW(f), nr = clone(r);
      nu[2] = [CL.R,CL.R,CL.R];
      for(let i=0;i<3;i++) { nr[i][0]=CL.Y; }
      return drawCube(nu, nr, nf);
    }
    case 'F2': {
      const nu = clone(u), nf = rot180(f), nr = clone(r);
      nu[2] = [CL.Y,CL.Y,CL.Y];
      for(let i=0;i<3;i++) { nr[i][0]=CL.W; }
      return drawCube(nu, nr, nf);
    }

    // ── B ──
    case 'B': {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nu[0] = [CL.R,CL.R,CL.R];
      for(let i=0;i<3;i++) { nr[i][2]=CL.Y; }
      return drawCube(nu, nr, nf);
    }
    case "B'": {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nu[0] = [CL.O,CL.O,CL.O];
      for(let i=0;i<3;i++) { nr[i][2]=CL.W; }
      return drawCube(nu, nr, nf);
    }
    case 'B2': {
      const nu = clone(u), nf = clone(f), nr = clone(r);
      nu[0] = [CL.Y,CL.Y,CL.Y];
      for(let i=0;i<3;i++) { nr[i][2]=CL.O; }
      return drawCube(nu, nr, nf);
    }

    default: return drawCube(u, r, f);
  }
}

function openLesson(id) {
  activeLesson = id;

  const section = TRAIL.find(s => s.section === activeSection);
  renderTrailNodes(section);

  let lesson = null;
  for (const s of TRAIL) {
    const found = s.nodes.find(n => n.id === id);
    if (found) { lesson = found; break; }
  }
  if (!lesson) return;

  const isDone = completedLessons.has(id);

  let bodyHTML = '';

  if (lesson.type === 'moves') {
    // Carrega progresso individual de cada movimento
    const moveProgress = JSON.parse(localStorage.getItem('ct_moves_' + id) || '{}');
    const learned = lesson.moves.filter(m => moveProgress[m.name]).length;
    const total   = lesson.moves.length;

    const cardsHTML = lesson.moves.map(m => {
      const isLearned = !!moveProgress[m.name];
      const pct = isLearned ? 100 : 50;
      return `<div class="move-card">
        <div class="move-card-cube">${getCubeSVGForMove(m.name)}</div>
        <div class="move-card-body">
          <div class="move-card-name">${m.name}</div>
          <div class="move-card-tag">notações básicas</div>
          <label class="move-card-check ${isLearned ? 'learned' : ''}">
            <input type="checkbox" ${isLearned ? 'checked' : ''} onchange="toggleMove('${id}','${m.name}')">
            Aprendido
          </label>
          <div class="move-progress-bar">
            <div class="move-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;
    }).join('');

    bodyHTML = `<div class="move-grid">${cardsHTML}</div>`;

  } else {
    const cardsHTML = lesson.cards.map((c, i) => `
      <div class="lcard" id="lcard-${i}" onclick="toggleLcard(${i})">
        <div class="lcard-head">
          <div class="lcard-icon">${c.icon}</div>
          <div class="lcard-title">${c.title}</div>
          <span class="lcard-arrow">▾</span>
        </div>
        <div class="lcard-body">
          <div class="lcard-text">${c.text}</div>
          ${c.alg ? `<div class="alg-box">${c.alg.replace(/\n/g,'<br>')}</div>` : ''}
          ${c.tip ? `<div class="tip-box">${c.tip}</div>` : ''}
        </div>
      </div>`).join('');
    bodyHTML = `<div class="lesson-cards">${cardsHTML}</div>`;
  }

  document.getElementById('lesson-detail').innerHTML = `
    <div class="lesson-header">
      <span class="lesson-section-pill">LIÇÃO</span>
      <div class="lesson-title">${lesson.title}</div>
      <div class="lesson-desc">${lesson.desc}</div>
    </div>
    ${bodyHTML}
    <div class="lesson-footer">
      <button class="btn-complete ${isDone ? 'done-state' : ''}" id="btn-complete" onclick="completeLesson('${id}')">
        ${isDone ? '✓ Concluído' : 'Marcar como concluído'}
      </button>
    </div>`;
}

function toggleMove(lessonId, moveName) {
  const key      = 'ct_moves_' + lessonId;
  const progress = JSON.parse(localStorage.getItem(key) || '{}');
  progress[moveName] = !progress[moveName];
  localStorage.setItem(key, JSON.stringify(progress));
  openLesson(lessonId); // re-renderiza
}

function toggleLcard(i) {
  document.getElementById('lcard-' + i).classList.toggle('open');
}

function completeLesson(id) {
  if (completedLessons.has(id)) {
    completedLessons.delete(id);
  } else {
    completedLessons.add(id);
  }
  saveCompleted();
  const section = TRAIL.find(s => s.section === activeSection);
  renderTrailNodes(section);
  const btn    = document.getElementById('btn-complete');
  const isDone = completedLessons.has(id);
  btn.textContent = isDone ? '✓ Concluído' : 'Marcar como concluído';
  btn.className   = 'btn-complete ' + (isDone ? 'done-state' : '');
}

// ── Navegação entre páginas ──
const LAST_PAGE_KEY = 'ct_last_page';
function saveLastPage(page) {
  // Não reabre batalha automaticamente ao recarregar
  if (page === 'battle') return;
  localStorage.setItem(LAST_PAGE_KEY, page);
}
function loadLastPage() {
  const p = localStorage.getItem(LAST_PAGE_KEY);
  return (p === 'timer' || p === 'learn' || p === 'login') ? p : null;
}

function showPage(page) {
  const timer  = document.querySelector('.layout');
  const login  = document.getElementById('page-login');
  const learn  = document.getElementById('page-learn');
  const battle = document.getElementById('page-battle');

  // Remove listeners anteriores
  document.removeEventListener('keydown', timerKeyDown);
  document.removeEventListener('keyup',   timerKeyUp);
  document.removeEventListener('keydown', battleKeyDown);
  document.removeEventListener('keyup',   battleKeyUp);

  const ranked = document.getElementById('page-ranked');

  // Esconde tudo
  timer.style.display  = 'none';
  if (login) login.style.display = 'none';
  learn.style.display  = 'none';
  battle.style.display = 'none';
  if (ranked) ranked.style.display = 'none';

  // Para listeners ranked
  document.removeEventListener('keydown', rankedKeyDown);
  document.removeEventListener('keyup',   rankedKeyUp);

  if (page === 'timer') {
    timer.style.display = 'grid';
    document.addEventListener('keydown', timerKeyDown);
    document.addEventListener('keyup',   timerKeyUp);
    updateRankWidget();
    saveLastPage('timer');

  } else if (page === 'login') {
    if (login) login.style.display = 'block';
    saveLastPage('login');

  } else if (page === 'learn') {
    learn.style.display = 'block';
    renderTrailOverview();
    saveLastPage('learn');

  } else if (page === 'battle') {
    battle.style.display = 'flex';
    document.addEventListener('keydown', battleKeyDown);
    document.addEventListener('keyup',   battleKeyUp);
    showBattleLobby();

  } else if (page === 'ranked') {
    const ranked = document.getElementById('page-ranked');
    if (ranked) {
      ranked.style.display = 'flex';
      showRankedLobby();
    }
    saveLastPage('ranked');
  }
}

function applyDedicatedMobileLayout() {
  if (!document.documentElement.classList.contains('mobile-mode')) return;

  const panelCenter = document.querySelector('.panel-center .center-inner');
  const panelRight = document.querySelector('.panel-right');
  const historyCard = document.querySelector('.history-card');
  const statsCard = document.getElementById('stats-card');
  const penaltiesCard = document.getElementById('card-penalties');

  if (panelCenter && penaltiesCard) {
    panelCenter.appendChild(penaltiesCard);
  }
  if (panelRight && historyCard && statsCard) {
    panelRight.insertBefore(statsCard, historyCard);
  }
}

// ═══════════════════════════════════════════════
//  SISTEMA DE RANK
// ═══════════════════════════════════════════════
const RANKS = [
  { name: 'Iniciante',   icon: '🪨', color: '#8B7355', min: 61*1000,       max: 999*60*1000 },
  { name: 'Aprendiz',    icon: '🥉', color: '#cd7f32', min: 51*1000,       max: 61*1000     },
  { name: 'Cuber',       icon: '🥈', color: '#aab0b8', min: 41*1000,       max: 51*1000     },
  { name: 'Cuber Pro',   icon: '🥇', color: '#f5c800', min: 31*1000,       max: 41*1000     },
  { name: 'Speed Cuber', icon: '💠', color: '#4fd1c5', min: 26*1000,       max: 31*1000     },
  { name: 'Elite Cuber', icon: '💎', color: '#7dd3fc', min: 21*1000,       max: 26*1000     },
  { name: 'Expert Cuber',icon: '🔺', color: '#86efac', min: 16*1000,       max: 21*1000     },
  { name: 'Legend Cuber',icon: '🔥', color: '#f87171', min: 11*1000,       max: 16*1000     },
  { name: 'Master Cuber',icon: '👑', color: '#d4f244', min: 0,             max: 11*1000     },
];

function getRank(avgMs) {
  if (!avgMs || isNaN(avgMs) || avgMs <= 0) return null;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (avgMs >= RANKS[i].min && avgMs < RANKS[i].max) return { ...RANKS[i], index: i };
  }
  return { ...RANKS[0], index: 0 };
}

// Rank salvo para detectar promoção
let _lastRankIndex = null;
const LAST_RANK_KEY = 'ct_last_rank_index';

function loadLastRankIndex() {
  const raw = localStorage.getItem(LAST_RANK_KEY);
  const n = raw == null ? null : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function saveLastRankIndex(idx) {
  if (idx == null) localStorage.removeItem(LAST_RANK_KEY);
  else localStorage.setItem(LAST_RANK_KEY, String(idx));
}

function updateRankWidget() {
  const times = currentTimes();
  const widget = document.getElementById('rank-widget');
  if (!widget) return;

  // Filtra apenas tempos válidos (números positivos, sem DNF)
  const validMs = times.filter(e => !e.dnf && typeof e.ms === 'number' && e.ms > 0 && !isNaN(e.ms)).map(e => e.ms);

  if (validMs.length < 3) {
    document.getElementById('rank-name').textContent   = 'Sem rank';
    document.getElementById('rank-div').textContent    = 'Faça ao menos 3 resoluções';
    document.getElementById('rank-emblem').textContent = '?';
    document.getElementById('rank-avg').textContent    = '';
    document.getElementById('rank-bar-fill').style.width = '0%';
    document.getElementById('rank-bar-low').textContent  = '';
    document.getElementById('rank-bar-high').textContent = '';
    widget.style.setProperty('--rank-color', '#555');
    _lastRankIndex = null;
    return;
  }

  const avgMs = validMs.reduce((a,b) => a+b, 0) / validMs.length;
  const rank  = getRank(avgMs);
  if (!rank) return;

  const isMaster = rank.name === 'Master Cuber';

  // Carrega o último rank persistido para não disparar ao recarregar
  if (_lastRankIndex === null) _lastRankIndex = loadLastRankIndex();

  // Só mostra quando houver promoção real (rank maior que o último salvo)
  if (_lastRankIndex !== null && rank.index > _lastRankIndex) {
    showRankUp(rank, false);
  }

  _lastRankIndex = rank.index;
  saveLastRankIndex(_lastRankIndex);

  // Quanto mais perto do min (tempo mais rápido), maior o progresso
  let pct = 0;
  if (!isMaster) {
    const range = rank.max - rank.min;
    pct = Math.max(0, Math.min(100, Math.round((rank.max - avgMs) / range * 100)));
  } else {
    pct = 100;
  }

  document.getElementById('rank-emblem').textContent = rank.icon;
  document.getElementById('rank-name').textContent   = rank.name;
  document.getElementById('rank-div').textContent    = isMaster ? '🏆 Nível máximo' : `Progresso no rank: ${pct}%`;
  document.getElementById('rank-bar-fill').style.width = pct + '%';
  document.getElementById('rank-bar-low').textContent  = isMaster ? '' : fmtTime(rank.max);
  document.getElementById('rank-bar-high').textContent = isMaster ? '' : fmtTime(rank.min);
  document.getElementById('rank-avg').textContent      = `média: ${fmtTime(Math.round(avgMs))}`;
  widget.style.setProperty('--rank-color', rank.color);
}

// ── Celebração de Rank Up ──────────────────────
const RANKUP_MSGS = {
  'Iniciante':    'Boa largada! Continue resolvendo para subir mais.',
  'Aprendiz':     'Evolucao constante! Seu progresso esta aparecendo.',
  'Cuber':        'Voce entrou no nivel Cuber! Consistencia em alta.',
  'Cuber Pro':    'Cuber Pro alcancado! Sua tecnica esta ficando afiada.',
  'Speed Cuber':  'Speed Cuber! Seus movimentos estao cada vez mais rapidos.',
  'Elite Cuber':  'Elite Cuber! Excelente controle e bom ritmo de solve.',
  'Expert Cuber': 'Expert Cuber! Voce esta muito perto do topo.',
  'Legend Cuber': 'Legend Cuber! Nivel altissimo de speedcubing.',
  'Master Cuber': '👑 MASTER CUBER! O nível mais alto. Perfeição.',
};

function spawnConfetti(container, color) {
  const colors = [color, '#ffffff', '#d4f244', '#f0a340', '#f87171', '#7dd3fc'];
  for (let i = 0; i < 48; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left       = Math.random() * 100 + '%';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width      = (6 + Math.random() * 6) + 'px';
    el.style.height     = (6 + Math.random() * 6) + 'px';
    el.style.borderRadius = Math.random() > .5 ? '50%' : '2px';
    const dur = 1.2 + Math.random() * 1.4;
    const delay = Math.random() * .6;
    el.style.animation  = `confettiFall ${dur}s ${delay}s linear forwards`;
    container.appendChild(el);
    setTimeout(() => el.remove(), (dur + delay) * 1000 + 100);
  }
}

function playRankUpSound(isMaster) {
  try {
    const ctx = getAudioCtx();
    const t   = ctx.currentTime;
    // Acorde ascendente suave: três notas em sequência
    const notes = isMaster
      ? [523.25, 659.25, 783.99, 1046.50]   // C5 E5 G5 C6 — fanfarra de master
      : [523.25, 659.25, 783.99];            // C5 E5 G5 — acorde maior alegre
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + i * 0.13);
      gain.gain.setValueAtTime(0, t + i * 0.13);
      gain.gain.linearRampToValueAtTime(0.18, t + i * 0.13 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.13 + 0.55);
      osc.start(t + i * 0.13);
      osc.stop(t + i * 0.13 + 0.6);
    });
    // Shimmer final suave
    setTimeout(() => {
      try {
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.type = 'sine';
        o2.frequency.setValueAtTime(1567.98, ctx.currentTime);
        o2.frequency.exponentialRampToValueAtTime(1318.51, ctx.currentTime + 0.4);
        g2.gain.setValueAtTime(0.10, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        o2.start(ctx.currentTime); o2.stop(ctx.currentTime + 0.5);
      } catch(e) {}
    }, notes.length * 130 + 40);
  } catch(e) {}
}

function showRankUp(rank, isFirst = false) {
  const overlay   = document.getElementById('rankup-overlay');
  const card      = overlay.querySelector('.rankup-card');
  const confetti  = document.getElementById('rankup-confetti');
  const isMaster  = rank.name === 'Master Cuber';
  const titleEl   = overlay.querySelector('.rankup-title');
  const labelEl   = overlay.querySelector('.rankup-label');

  // Texto muda conforme contexto
  if (isFirst) {
    labelEl.textContent = 'Primeiro Rank!';
    titleEl.textContent = 'Você está ranqueado';
  } else {
    labelEl.textContent = 'Promoção!';
    titleEl.textContent = 'Novo Rank';
  }

  // Popula conteúdo
  overlay.style.setProperty('--rankup-color', rank.color);
  card.style.setProperty('--rankup-color', rank.color);
  document.getElementById('rankup-icon').textContent = rank.icon;
  document.getElementById('rankup-name').textContent = rank.name;
  document.getElementById('rankup-div').textContent  = isMaster ? '👑 Nível Máximo' : '';
  document.getElementById('rankup-msg').textContent  = isFirst
    ? 'Você completou 3 resoluções e entrou no ranking. Continue melhorando!'
    : (RANKUP_MSGS[rank.name] || 'Parabéns pela promoção!');

  // Brilho no rank-widget
  const widget = document.getElementById('rank-widget');
  widget.style.boxShadow = `0 0 24px ${rank.color}55`;
  setTimeout(() => widget.style.boxShadow = '', 3000);

  // Mostra overlay
  overlay.classList.add('active');

  // Som discreto
  setTimeout(() => playRankUpSound(isMaster), 150);

  // Confete
  confetti.innerHTML = '';
  setTimeout(() => spawnConfetti(confetti, rank.color), 200);
}

function closeRankUp() {
  const overlay = document.getElementById('rankup-overlay');
  overlay.classList.remove('active');
}

// ═══════════════════════════════════════════════
//  SUPABASE — PRESENÇA ONLINE + PERFIL
// ═══════════════════════════════════════════════
const SUPABASE_URL    = 'https://ftkbfuvcqtdmnysxhjnd.supabase.co';
const SUPABASE_ANON   = 'sb_publishable_06xLBenyCX3gjzhGZAns5Q_wCgE0EMc';
const sbHeaders       = { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON, 'Content-Type': 'application/json' };

// ID único anônimo persistido
function getMyId() {
  let id = localStorage.getItem('ct_uid');
  if (!id) { id = 'u_' + Math.random().toString(36).slice(2,10); localStorage.setItem('ct_uid', id); }
  return id;
}

const MY_ID = getMyId();
const AVATARS = ['🧊','🔥','⚡','🌀','🎯','💎','🏆','🦊','🐉','🧩','🎲','🌟'];

let myProfile = JSON.parse(localStorage.getItem('ct_profile') || 'null') || { nickname: 'Cuber ' + MY_ID.slice(2,6), avatar: '🧊' };
let selectedAvatar = myProfile.avatar;
let onlinePanelOpen = false;
let pingInterval = null;

// ── REST helpers ──────────────────────────────
async function sbGet(table, params='') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: sbHeaders });
  return r.json();
}
async function sbUpsert(table, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
}
async function sbDelete(table, filter) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: sbHeaders });
}

// ── Presença ──────────────────────────────────
async function pingPresence() {
  const times  = currentTimes();
  const validMs = times.filter(e => !e.dnf).map(e => e.ms);
  const avgMs  = validMs.length >= 3 ? validMs.reduce((a,b)=>a+b,0)/validMs.length : null;
  const rank   = avgMs ? getRank(avgMs) : null;
  await sbUpsert('presences', {
    id         : MY_ID,
    nickname   : myProfile.nickname,
    avatar     : myProfile.avatar,
    rank_name  : rank ? rank.name : null,
    rank_div   : null,
    rank_icon  : rank ? rank.icon : null,
    rank_color : rank ? rank.color: null,
    last_seen  : new Date().toISOString()
  });
}

async function cleanStale() {
  // Remove presenças com last_seen > 45s atrás
  const cutoff = new Date(Date.now() - 45000).toISOString();
  await sbDelete('presences', `last_seen=lt.${cutoff}`);
}

async function fetchOnline() {
  await cleanStale();
  const rows = await sbGet('presences', 'order=nickname.asc');
  if (!Array.isArray(rows)) return;
  document.getElementById('online-count').textContent = rows.length;
  if (onlinePanelOpen) renderOnlineList(rows);
}

function renderOnlineList(rows) {
  const el = document.getElementById('online-list');
  if (!rows.length) { el.innerHTML = '<div style="font-size:13px;color:var(--muted);text-align:center;padding:16px">Ninguém online</div>'; return; }
  el.innerHTML = rows.map(p => {
    const isMe = p.id === MY_ID;
    const rankStr = p.rank_name ? `${p.rank_icon || ''} ${p.rank_name}` : 'Sem rank';
    return `<div class="online-player ${isMe ? 'is-me' : ''}">
      <div class="op-avatar ${isMe ? 'is-me' : ''}" style="${p.rank_color ? 'border-color:'+p.rank_color : ''}">${p.avatar}</div>
      <div class="op-info">
        <div class="op-name">${p.nickname}</div>
        <div class="op-rank">${rankStr}</div>
      </div>
      ${isMe ? '<span class="op-you">você</span>' : ''}
    </div>`;
  }).join('');
}

function toggleOnlinePanel() {
  onlinePanelOpen = !onlinePanelOpen;
  const panel = document.getElementById('online-panel');
  panel.style.display = onlinePanelOpen ? 'flex' : 'none';
  if (onlinePanelOpen) fetchOnline();
}

// ── Perfil ────────────────────────────────────
function openProfileModal() {
  document.getElementById('profile-nickname').value = myProfile.nickname;
  selectedAvatar = myProfile.avatar;
  const picker = document.getElementById('avatar-picker');
  picker.innerHTML = AVATARS.map(a => `
    <div class="avatar-opt ${a === selectedAvatar ? 'selected' : ''}" onclick="selectAvatar('${a}')">${a}</div>
  `).join('');
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeProfileModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

function selectAvatar(a) {
  selectedAvatar = a;
  document.querySelectorAll('.avatar-opt').forEach(el => {
    el.classList.toggle('selected', el.textContent === a);
  });
}

async function saveProfile() {
  const nick = document.getElementById('profile-nickname').value.trim();
  if (!nick) return;
  myProfile = { nickname: nick, avatar: selectedAvatar };
  localStorage.setItem('ct_profile', JSON.stringify(myProfile));
  closeProfileModal();
  await pingPresence();
  fetchOnline();
  showToast('Perfil salvo!');
}

// ── Init presença ─────────────────────────────
async function initPresence() {
  await pingPresence();
  await fetchOnline();
  pingInterval = setInterval(async () => {
    await pingPresence();
    await fetchOnline();
  }, 20000);
  // Remove ao sair da página
  window.addEventListener('beforeunload', () => sbDelete('presences', `id=eq.${MY_ID}`));
}

// ═══════════════════════════════════════════════
//  MODO BATALHA
// ═══════════════════════════════════════════════
let battleRoom     = null;
let battleIsHost   = false;
let battlePollId   = null;
let battleTimerState = 'idle';
let battleStart    = 0;
let battleRafId    = null;
let battleHoldTimer = null;
let battleHoldReady = false;
let myWins = 0, oppWins = 0;
let myRoundDone = false, oppRoundDone = false;
let myRoundTime = null;

function genRoomCode() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

// ── REST batalha ─────────────────────────────
async function sbGetRoom(id) {
  const r = await sbGet('battle_rooms', `id=eq.${id}&limit=1`);
  return Array.isArray(r) && r.length ? r[0] : null;
}
async function sbGetResults(roomId, round) {
  return await sbGet('battle_results', `room_id=eq.${roomId}&round=eq.${round}`);
}
async function sbInsertResult(roomId, playerId, round, timeMs) {
  await fetch(`${SUPABASE_URL}/rest/v1/battle_results`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ room_id: roomId, player_id: playerId, round, time_ms: timeMs })
  });
}

// ── Criar sala ───────────────────────────────
async function createRoom() {
  const code = genRoomCode();
  const scramble = genScramble();
  await sbUpsert('battle_rooms', {
    id             : code,
    scramble       : scramble,
    host_id        : MY_ID,
    host_nickname  : myProfile.nickname,
    host_avatar    : myProfile.avatar,
    status         : 'waiting'
  });
  battleRoom   = { id: code, scramble, host_id: MY_ID, status: 'waiting', round: 1 };
  battleIsHost = true;
  showBattleWaiting(code);
  battlePollId = setInterval(pollRoom, 2000);
}

// ── Entrar na sala ───────────────────────────
async function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code || code.length < 4) { showToast('Código inválido.'); return; }
  const room = await sbGetRoom(code);
  if (!room) { showToast('Sala não encontrada.'); return; }
  if (room.status !== 'waiting') { showToast('Sala já em andamento.'); return; }

  // Atualiza guest
  await fetch(`${SUPABASE_URL}/rest/v1/battle_rooms?id=eq.${code}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify({ guest_id: MY_ID, guest_nickname: myProfile.nickname, guest_avatar: myProfile.avatar, status: 'active' })
  });

  battleRoom   = { ...room, guest_id: MY_ID, status: 'active' };
  battleIsHost = false;
  myWins = 0; oppWins = 0;
  startArena(room.scramble, room.round || 1);
  battlePollId = setInterval(pollRoom, 2000);
}

// ── Polling da sala ──────────────────────────
async function pollRoom() {
  if (!battleRoom) return;
  const room = await sbGetRoom(battleRoom.id);
  if (!room) { leaveBattle(); showToast('Sala encerrada.'); return; }

  // Host detecta que guest entrou
  if (battleIsHost && room.status === 'active' && battleRoom.status === 'waiting') {
    battleRoom = room;
    myWins = 0; oppWins = 0;
    startArena(room.scramble, room.round || 1);
    return;
  }

  // Checa se o outro jogador finalizou o round
  if (room.status === 'active') {
    const results = await sbGetResults(room.id, room.round);
    const myResult  = results.find(r => r.player_id === MY_ID);
    const oppResult = results.find(r => r.player_id !== MY_ID);

    if (myResult)  { myRoundDone = true;  updateBattleScore(myResult.time_ms, null); }
    if (oppResult) { oppRoundDone = true; updateBattleScore(null, oppResult.time_ms); }

    if (myResult && oppResult) {
      // Round completo — mostra resultado
      resolveRound(myResult.time_ms, oppResult.time_ms, room);
    }
  }

  // Checa se adversário saiu
  if (room.status === 'abandoned') {
    clearInterval(battlePollId);
    setBattleStatus('🏆 Adversário saiu. Você venceu!', 'winner');
    setTimeout(() => showBattleLobby(), 4000);
  }
}

// ── Arena ────────────────────────────────────
function startArena(scramble, round) {
  document.getElementById('battle-lobby').style.display   = 'none';
  document.getElementById('battle-waiting').style.display = 'none';
  document.getElementById('battle-arena').style.display   = 'flex';

  myRoundDone = false; oppRoundDone = false; myRoundTime = null;

  document.getElementById('battle-round').textContent   = round;
  document.getElementById('battle-scramble').textContent = scramble;
  document.getElementById('battle-timer').textContent    = '0.00';
  document.getElementById('battle-timer').className      = 'timer-display idle';
  document.getElementById('battle-hint').innerHTML       = 'segure <kbd>espaço</kbd> para iniciar';
  setBattleStatus('');

  // Preenche info dos jogadores
  const isHost = battleIsHost;
  document.getElementById('bp-me-avatar').textContent  = myProfile.avatar;
  document.getElementById('bp-me-name').textContent    = myProfile.nickname + ' (você)';
  document.getElementById('bp-me-score').textContent   = '—';
  document.getElementById('bp-me-wins').textContent    = myWins + ' vitórias';
  document.getElementById('bp-opp-avatar').textContent = battleRoom.guest_avatar || battleRoom.host_avatar || '❓';
  document.getElementById('bp-opp-name').textContent   = (battleIsHost ? battleRoom.guest_nickname : battleRoom.host_nickname) || 'Adversário';
  document.getElementById('bp-opp-score').textContent  = '—';
  document.getElementById('bp-opp-wins').textContent   = oppWins + ' vitórias';
}

function updateBattleScore(myMs, oppMs) {
  if (myMs  !== null) { document.getElementById('bp-me-score').textContent  = fmtTime(myMs);  document.getElementById('bp-me-score').className  = 'bp-score done'; }
  if (oppMs !== null) { document.getElementById('bp-opp-score').textContent = fmtTime(oppMs); document.getElementById('bp-opp-score').className = 'bp-score done'; }
}

function resolveRound(myMs, oppMs, room) {
  clearInterval(battlePollId);
  const iWon = myMs < oppMs;
  if (iWon) myWins++; else oppWins++;

  document.getElementById('bp-me-wins').textContent  = myWins  + ' vitórias';
  document.getElementById('bp-opp-wins').textContent = oppWins + ' vitórias';
  document.getElementById('bp-me').classList.toggle('winning', iWon);
  document.getElementById('bp-me').classList.toggle('losing',  !iWon);
  document.getElementById('bp-opp').classList.toggle('winning', !iWon);
  document.getElementById('bp-opp').classList.toggle('losing',  iWon);

  if (iWon) setBattleStatus(`🏆 Você venceu o round! ${fmtTime(myMs)} vs ${fmtTime(oppMs)}`, 'winner');
  else       setBattleStatus(`😤 Adversário venceu. ${fmtTime(oppMs)} vs ${fmtTime(myMs)}`, 'loser');

  // Próximo round em 4s (só o host avança o round)
  setTimeout(async () => {
    const newRound = (room.round || 1) + 1;
    const newScramble = genScramble();
    if (battleIsHost) {
      await fetch(`${SUPABASE_URL}/rest/v1/battle_rooms?id=eq.${room.id}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ round: newRound, scramble: newScramble })
      });
    }
    battleRoom = { ...battleRoom, round: newRound, scramble: newScramble };
    startArena(newScramble, newRound);
    battlePollId = setInterval(pollRoom, 2000);
  }, 4000);
}

function setBattleStatus(msg, cls) {
  const el = document.getElementById('battle-status');
  el.textContent = msg;
  el.className = 'battle-status' + (cls ? ' ' + cls : '');
}

// ── Timer da batalha ─────────────────────────
function battlePressDown() {
  if (battleTimerState === 'running') {
    // Para o timer
    cancelAnimationFrame(battleRafId);
    const t = Date.now() - battleStart;
    battleTimerState = 'idle';
    myRoundTime = t;
    document.getElementById('battle-timer').textContent  = fmtTime(t);
    document.getElementById('battle-timer').className    = 'timer-display idle';
    document.getElementById('battle-hint').innerHTML     = '⏳ Aguardando adversário...';
    updateBattleScore(t, null);
    setBattleStatus('Aguardando adversário finalizar...');
    // Salva resultado
    sbInsertResult(battleRoom.id, MY_ID, battleRoom.round, t);
    return;
  }
  if (battleTimerState === 'idle') {
    battleHoldReady = false;
    battleTimerState = 'holding';
    document.getElementById('battle-timer').className = 'timer-display holding';
    document.getElementById('battle-hint').innerHTML  = 'continue segurando...';
    battleHoldTimer = setTimeout(() => {
      battleHoldReady = true;
      document.getElementById('battle-timer').className = 'timer-display ready';
      document.getElementById('battle-hint').innerHTML  = 'pode soltar!';
    }, 300);
  }
}

function battlePressUp() {
  clearTimeout(battleHoldTimer);
  if (battleTimerState === 'holding') {
    if (battleHoldReady) {
      // Inicia timer
      battleTimerState = 'running';
      battleStart = Date.now();
      document.getElementById('battle-timer').className = 'timer-display running';
      document.getElementById('battle-hint').innerHTML  = 'aperte <kbd>espaço</kbd> para finalizar';
      function tick() {
        document.getElementById('battle-timer').textContent = fmtTime(Date.now() - battleStart);
        battleRafId = requestAnimationFrame(tick);
      }
      battleRafId = requestAnimationFrame(tick);
    } else {
      battleTimerState = 'idle';
      document.getElementById('battle-timer').className = 'timer-display idle';
      document.getElementById('battle-hint').innerHTML  = 'segure <kbd>espaço</kbd> para iniciar';
    }
  }
}

// ── Navegação da batalha ─────────────────────
function showBattleLobby() {
  document.getElementById('battle-lobby').style.display   = 'flex';
  document.getElementById('battle-waiting').style.display = 'none';
  document.getElementById('battle-arena').style.display   = 'none';
}

function showBattleWaiting(code) {
  document.getElementById('battle-lobby').style.display   = 'none';
  document.getElementById('battle-waiting').style.display = 'flex';
  document.getElementById('battle-arena').style.display   = 'none';
  document.getElementById('battle-code-display').textContent = code;
}

async function cancelRoom() {
  if (battleRoom) await sbDelete('battle_rooms', `id=eq.${battleRoom.id}`);
  clearInterval(battlePollId);
  battleRoom = null;
  showBattleLobby();
}

async function leaveBattle() {
  clearInterval(battlePollId);
  cancelAnimationFrame(battleRafId);
  if (battleRoom && battleRoom.status === 'active') {
    await fetch(`${SUPABASE_URL}/rest/v1/battle_rooms?id=eq.${battleRoom.id}`, {
      method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ status: 'abandoned' })
    });
  } else if (battleRoom && battleIsHost) {
    await sbDelete('battle_rooms', `id=eq.${battleRoom.id}`);
  }
  battleRoom = null; battleTimerState = 'idle';
  showPage('timer');
}

// Teclado na batalha
function battleKeyDown(e) {
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); battlePressDown(); }
  if (e.code === 'Escape') { cancelAnimationFrame(battleRafId); battleTimerState = 'idle'; document.getElementById('battle-timer').className = 'timer-display idle'; document.getElementById('battle-timer').textContent = '0.00'; document.getElementById('battle-hint').innerHTML = 'segure <kbd>espaço</kbd> para iniciar'; }
}
function battleKeyUp(e) {
  if (e.code === 'Space') { e.preventDefault(); battlePressUp(); }
}

// ═══════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════

const THEMES = {
  green  : { accent: '#d4f244', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  blue   : { accent: '#7dd3fc', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  purple : { accent: '#c084fc', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  red    : { accent: '#f87171', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  orange : { accent: '#fb923c', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  teal   : { accent: '#34d399', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  pink   : { accent: '#f472b6', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  amber  : { accent: '#fbbf24', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  white  : { accent: '#ffffff', bg: '#0d0d0d', text: '#f0ede6', timer: '#ffffff', scramble: '#cccccc' },
  cyan   : { accent: '#22d3ee', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  lime   : { accent: '#a3e635', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  rose   : { accent: '#fb7185', bg: '#0d0d0d', text: '#f0ede6', timer: '#f0ede6', scramble: '#f0ede6' },
  // Temas com fundo claro
  light  : { accent: '#2563eb', bg: '#f8fafc', text: '#1e293b', timer: '#1e293b', scramble: '#334155', surface: '#ffffff', surface2: '#f1f5f9', border: '#e2e8f0', border2: '#cbd5e1', muted: '#94a3b8' },
  paper  : { accent: '#b45309', bg: '#fdf6e3', text: '#3b2f1a', timer: '#3b2f1a', scramble: '#5a4a35', surface: '#faefd4', surface2: '#f0e6c8', border: '#e6d9b8', border2: '#d4c4a0', muted: '#9a8466' },
};

const ALL_STATS = [
  { id:'count', label:'Tempos'  },
  { id:'best',  label:'Melhor'  },
  { id:'worst', label:'Pior'    },
  { id:'mean',  label:'Média'   },
  { id:'sigma', label:'Desvio σ'},
  { id:'ao3',   label:'ao3'     },
  { id:'ao5',   label:'ao5'     },
  { id:'ao12',  label:'ao12'    },
  { id:'ao50',  label:'ao50'    },
  { id:'ao100', label:'ao100'   },
];

function saveCfg() {
  cfg.sound         = document.getElementById('cfg-sound').checked;
  cfg.volume        = parseInt(document.getElementById('cfg-volume').value);
  cfg.inspection    = document.getElementById('cfg-inspection').checked;
  cfg.autoDnf       = document.getElementById('cfg-auto-dnf').checked;
  cfg.showScramble  = document.getElementById('cfg-show-scramble').checked;
  cfg.showRank      = document.getElementById('cfg-show-rank').checked;
  cfg.onlineVisible = document.getElementById('cfg-online-visible').checked;
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
}

function applyCfg() {
  // Tema de cor
  const t = THEMES[cfg.theme] || THEMES.green;

  // Variáveis de cor padrão do tema (ou custom se definido)
  const accent   = cfg.customAccentColor  || t.accent;
  const bg       = cfg.customBgColor      || t.bg      || '#0d0d0d';
  const text     = cfg.customTextColor    || t.text     || '#f0ede6';
  const timer    = cfg.customTimerColor   || t.timer    || text;
  const scramble = cfg.customScrambleColor|| t.scramble || text;

  const r = document.documentElement;
  r.style.setProperty('--accent',  accent);
  r.style.setProperty('--accent2', accent);
  r.style.setProperty('--bg',      bg);
  r.style.setProperty('--text',    text);
  r.style.setProperty('--timer-color',    timer);
  r.style.setProperty('--scramble-color', scramble);

  // Variáveis de superfície: temas claros definem as suas, dark usa padrão
  if (t.surface)  r.style.setProperty('--surface',  t.surface);
  else r.style.removeProperty('--surface');
  if (t.surface2) r.style.setProperty('--surface2', t.surface2);
  else r.style.removeProperty('--surface2');
  if (t.border)   r.style.setProperty('--border',   t.border);
  else r.style.removeProperty('--border');
  if (t.border2)  r.style.setProperty('--border2',  t.border2);
  else r.style.removeProperty('--border2');
  if (t.muted)    r.style.setProperty('--muted',    t.muted);
  else r.style.removeProperty('--muted');

  // Sync pickers de cor customizada na UI
  ['timer','scramble','bg','text','accent'].forEach(k => {
    const el = document.getElementById('custom-' + k + '-color');
    if (el) {
      const val = cfg['custom' + k.charAt(0).toUpperCase() + k.slice(1) + 'Color'];
      el.value = val || (k === 'timer' ? timer : k === 'scramble' ? scramble : k === 'bg' ? bg : k === 'text' ? text : accent);
    }
  });

  // Tamanho do timer
  const sizes = { small: 'clamp(40px,6vw,72px)', medium: 'clamp(56px,9vw,108px)', large: 'clamp(80px,13vw,148px)' };
  document.querySelectorAll('.timer-display').forEach(el => el.style.fontSize = sizes[cfg.timerSize] || sizes.medium);

  // Scramble
  const sc = document.querySelector('.scramble-center-card');
  if (sc) sc.style.display = cfg.showScramble ? '' : 'none';

  // Rank widget
  const rw = document.getElementById('rank-widget');
  if (rw) rw.style.display = cfg.showRank ? '' : 'none';

  // Stats visíveis
  ALL_STATS.forEach(s => {
    const el = document.getElementById('s-' + s.id)?.closest('.stat-item');
    if (el) el.style.display = cfg.visibleStats.includes(s.id) ? '' : 'none';
  });

  // Atualiza botões ativos no painel
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.getAttribute('onclick') === `setTheme('${cfg.theme}')`);
  });
  document.querySelectorAll('.font-size-btn').forEach(el => {
    const s = el.getAttribute('onclick').match(/'(\w+)'/)?.[1];
    el.classList.toggle('active', s === cfg.timerSize);
  });
  document.querySelectorAll('.hold-btn').forEach(el => {
    const v = parseInt(el.getAttribute('onclick').match(/\d+/)?.[0]);
    el.classList.toggle('active', v === cfg.holdTime);
  });

  // Stat toggle buttons
  document.querySelectorAll('.stat-toggle-btn').forEach(el => {
    const id = el.dataset.stat;
    el.classList.toggle('active', cfg.visibleStats.includes(id));
  });

  // Perfil no painel
  const pn = document.getElementById('cfg-profile-name');
  if (pn) pn.textContent = `${myProfile?.avatar || '🧊'} ${myProfile?.nickname || '—'}`;
}

function loadCfgUI() {
  document.getElementById('cfg-sound').checked         = cfg.sound;
  document.getElementById('cfg-volume').value          = cfg.volume;
  document.getElementById('cfg-inspection').checked    = cfg.inspection;
  document.getElementById('cfg-auto-dnf').checked      = cfg.autoDnf;
  document.getElementById('cfg-show-scramble').checked = cfg.showScramble;
  document.getElementById('cfg-show-rank').checked     = cfg.showRank;
  document.getElementById('cfg-online-visible').checked= cfg.onlineVisible;

  // Stats toggle grid
  const grid = document.getElementById('stats-toggle-grid');
  if (grid) {
    grid.innerHTML = ALL_STATS.map(s => `
      <button class="stat-toggle-btn ${cfg.visibleStats.includes(s.id) ? 'active' : ''}"
              data-stat="${s.id}" onclick="toggleStat('${s.id}')">${s.label}</button>
    `).join('');
  }

  applyCfg();
}

function toggleStat(id) {
  const idx = cfg.visibleStats.indexOf(id);
  if (idx === -1) cfg.visibleStats.push(id);
  else if (cfg.visibleStats.length > 1) cfg.visibleStats.splice(idx, 1);
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
  // Atualiza botão
  const btn = document.querySelector(`.stat-toggle-btn[data-stat="${id}"]`);
  if (btn) btn.classList.toggle('active', cfg.visibleStats.includes(id));
}

function setTheme(theme) {
  cfg.theme = theme;
  // Limpa customizações ao trocar de tema predefinido
  cfg.customTimerColor    = null;
  cfg.customScrambleColor = null;
  cfg.customBgColor       = null;
  cfg.customTextColor     = null;
  cfg.customAccentColor   = null;
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
}

function setCustomColor(key, value) {
  // key: 'timer' | 'scramble' | 'bg' | 'text' | 'accent'
  const cfgKey = 'custom' + key.charAt(0).toUpperCase() + key.slice(1) + 'Color';
  cfg[cfgKey] = value;
  cfg.theme = 'custom';
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
  // Marca todos os swatches como inativos ao usar custom
  document.querySelectorAll('.theme-swatch').forEach(el => el.classList.remove('active'));
}

function resetCustomColors() {
  cfg.customTimerColor    = null;
  cfg.customScrambleColor = null;
  cfg.customBgColor       = null;
  cfg.customTextColor     = null;
  cfg.customAccentColor   = null;
  cfg.theme = 'green';
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
  loadCfgUI();
}

function setTimerSize(size) {
  cfg.timerSize = size;
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
}

function setHoldTime(ms) {
  cfg.holdTime = ms;
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  applyCfg();
}

function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) loadCfgUI();
}

newScramble();
applyDedicatedMobileLayout();
renderAll();
updateScramblePreview();
initScramblePreviewState();
updateRankWidget();
initPresence();
showPage(loadLastPage() || 'timer');
loadCfgUI();


// ═══════════════════════════════════════════════
//  MODO RANKED
// ═══════════════════════════════════════════════

const RANKED_WIN_TROPHIES  =  7;
const RANKED_LOSS_TROPHIES =  5;
const RANKED_MAX_REMATCHES =  3;  // máx de MDs entre o mesmo par
const RANKED_MATCH_ROUNDS  =  1;  // MD1

let rankedMatch       = null;
let rankedIsHost      = false;
let rankedPollId      = null;
let rankedSearchTimer = null;
let rankedSearchSecs  = 0;
let rankedTimerState  = 'idle';
let rankedStart       = 0;
let rankedRafId       = null;
let rankedHoldTimer   = null;
let rankedHoldReady   = false;
let rMyWins = 0, rOppWins = 0;
let rMyDone = false, rOppDone = false;
let rMyTime = null;

// ── REST helpers ranked ────────────────────────
async function sbGetRankedMatch(id) {
  const r = await sbGet('ranked_matches', `id=eq.${id}&limit=1`);
  return Array.isArray(r) && r.length ? r[0] : null;
}
async function sbGetRankedResults(roomId, round) {
  return await sbGet('ranked_results', `room_id=eq.${roomId}&round=eq.${round}`);
}
async function sbInsertRankedResult(roomId, playerId, round, timeMs) {
  await fetch(`${SUPABASE_URL}/rest/v1/ranked_results`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ room_id: roomId, player_id: playerId, round, time_ms: timeMs })
  });
}
async function sbGetMyRankedProfile() {
  const r = await sbGet('ranked_profiles', `id=eq.${MY_ID}&limit=1`);
  return Array.isArray(r) && r.length ? r[0] : null;
}
async function sbUpsertRankedProfile(trophies, wins, losses) {
  await sbUpsert('ranked_profiles', {
    id: MY_ID,
    nickname: myProfile.nickname,
    avatar: myProfile.avatar,
    trophies,
    total_wins: wins,
    total_losses: losses,
    updated_at: new Date().toISOString()
  });
}
async function getMatchCountBetween(a, b) {
  // par ordenado para garantir unicidade
  const [pa, pb] = [a, b].sort();
  const r = await sbGet('ranked_history', `player_a=eq.${pa}&player_b=eq.${pb}&limit=1`);
  return Array.isArray(r) && r.length ? r[0].match_count : 0;
}
async function incrementMatchCount(a, b) {
  const [pa, pb] = [a, b].sort();
  const existing = await sbGet('ranked_history', `player_a=eq.${pa}&player_b=eq.${pb}&limit=1`);
  if (Array.isArray(existing) && existing.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/ranked_history?player_a=eq.${pa}&player_b=eq.${pb}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ match_count: existing[0].match_count + 1, last_match: new Date().toISOString() })
    });
  } else {
    await sbUpsert('ranked_history', { player_a: pa, player_b: pb, match_count: 1, last_match: new Date().toISOString() });
  }
}
async function resetMatchCountBetween(a, b) {
  const [pa, pb] = [a, b].sort();
  await fetch(`${SUPABASE_URL}/rest/v1/ranked_history?player_a=eq.${pa}&player_b=eq.${pb}`, {
    method: 'PATCH',
    headers: sbHeaders,
    body: JSON.stringify({ match_count: 0, last_match: new Date().toISOString() })
  });
}

// ── Perfil e troféus ───────────────────────────
let myRankedProfile = null;

async function loadMyRankedProfile() {
  let p = await sbGetMyRankedProfile();
  if (!p) {
    await sbUpsertRankedProfile(0, 0, 0);
    p = { id: MY_ID, nickname: myProfile.nickname, avatar: myProfile.avatar, trophies: 0, total_wins: 0, total_losses: 0 };
  }
  myRankedProfile = p;
  return p;
}

function updateRankedProfileUI(p) {
  if (!p) return;
  const avatar = p.avatar || myProfile.avatar;
  const name   = p.nickname || myProfile.nickname;
  const el = id => document.getElementById(id);
  if (el('ranked-lobby-avatar'))   el('ranked-lobby-avatar').textContent   = avatar;
  if (el('ranked-lobby-name'))     el('ranked-lobby-name').textContent     = name;
  if (el('ranked-lobby-trophies')) el('ranked-lobby-trophies').textContent = p.trophies;
  if (el('ranked-lobby-record'))   el('ranked-lobby-record').textContent   = `${p.total_wins}V · ${p.total_losses}D`;
  if (el('ranked-my-trophies-header')) el('ranked-my-trophies-header').textContent = `🏆 ${p.trophies}`;
}

// ── Matchmaking ────────────────────────────────
async function findRankedMatch() {
  // Garante perfil carregado
  if (!myRankedProfile) await loadMyRankedProfile();

  // Mostra animação de busca
  document.getElementById('ranked-search-area').style.display    = 'none';
  document.getElementById('ranked-searching').style.display      = 'flex';
  document.getElementById('ranked-tab-leaderboard').style.display = 'none';
  document.getElementById('ranked-tab-history').style.display    = 'none';
  document.querySelector('.ranked-tabs').style.display           = 'none';
  document.getElementById('ranked-result').style.display         = 'none';
  document.getElementById('ranked-lobby').style.display          = 'flex';
  document.getElementById('ranked-arena').style.display          = 'none';

  rankedSearchSecs = 0;
  document.getElementById('ranked-search-time').textContent = '0s';
  rankedSearchTimer = setInterval(() => {
    rankedSearchSecs++;
    document.getElementById('ranked-search-time').textContent = rankedSearchSecs + 's';
  }, 1000);

  // Entra na fila
  await sbUpsert('ranked_queue', {
    id: MY_ID,
    nickname: myProfile.nickname,
    avatar: myProfile.avatar,
    trophies: myRankedProfile.trophies,
    joined_at: new Date().toISOString()
  });

  // Poll matchmaking
  rankedPollId = setInterval(pollRankedMatchmaking, 2500);
}

async function cancelRankedSearch() {
  clearInterval(rankedPollId);
  clearInterval(rankedSearchTimer);
  await sbDelete('ranked_queue', `id=eq.${MY_ID}`);
  showRankedLobby();
}

async function pollRankedMatchmaking() {
  // Verifica se já foi colocado em uma partida (como guest)
  const myMatch = await sbGet('ranked_matches', `guest_id=eq.${MY_ID}&status=eq.active&order=created_at.desc&limit=1`);
  if (Array.isArray(myMatch) && myMatch.length) {
    clearInterval(rankedPollId);
    clearInterval(rankedSearchTimer);
    rankedMatch   = myMatch[0];
    rankedIsHost  = false;
    rMyWins = 0; rOppWins = 0;
    await sbDelete('ranked_queue', `id=eq.${MY_ID}`);
    startRankedArena(rankedMatch.scramble, 1);
    return;
  }

  // Tenta fazer o match como host
  // Limpa fila velha (> 30s)
  const cutoff = new Date(Date.now() - 30000).toISOString();
  await sbDelete('ranked_queue', `joined_at=lt.${cutoff}`);

  const queue = await sbGet('ranked_queue', `id=neq.${MY_ID}&order=joined_at.asc&limit=20`);
  if (!Array.isArray(queue) || !queue.length) return;

  // Filtra adversários que não atingiram o limite de rematches
  for (const candidate of queue) {
    const count = await getMatchCountBetween(MY_ID, candidate.id);
    if (count >= RANKED_MAX_REMATCHES) continue;

    // Encontrou adversário! Cria a partida
    clearInterval(rankedPollId);
    clearInterval(rankedSearchTimer);

    const matchId  = genRoomCode();
    const scramble = genScramble();

    await sbUpsert('ranked_matches', {
      id            : matchId,
      scramble,
      host_id       : MY_ID,
      host_nickname : myProfile.nickname,
      host_avatar   : myProfile.avatar,
      guest_id      : candidate.id,
      guest_nickname: candidate.nickname,
      guest_avatar  : candidate.avatar,
      status        : 'active',
      round         : 1,
      host_wins     : 0,
      guest_wins    : 0,
      created_at    : new Date().toISOString()
    });

    // Remove ambos da fila
    await sbDelete('ranked_queue', `id=eq.${MY_ID}`);
    await sbDelete('ranked_queue', `id=eq.${candidate.id}`);

    rankedMatch   = { id: matchId, scramble, host_id: MY_ID, guest_id: candidate.id,
                      host_nickname: myProfile.nickname, host_avatar: myProfile.avatar,
                      guest_nickname: candidate.nickname, guest_avatar: candidate.avatar,
                      status: 'active', round: 1, host_wins: 0, guest_wins: 0 };
    rankedIsHost  = true;
    rMyWins = 0; rOppWins = 0;
    startRankedArena(scramble, 1);
    return;
  }
}

// ── Arena ranked ───────────────────────────────
function startRankedArena(scramble, round) {
  document.getElementById('ranked-lobby').style.display  = 'none';
  document.getElementById('ranked-arena').style.display  = 'flex';
  document.getElementById('ranked-result').style.display = 'none';

  const isHost = rankedIsHost;
  const opp    = isHost
    ? { name: rankedMatch.guest_nickname, avatar: rankedMatch.guest_avatar }
    : { name: rankedMatch.host_nickname,  avatar: rankedMatch.host_avatar  };

  document.getElementById('ranked-round').textContent     = round;
  document.getElementById('ranked-scramble').textContent  = scramble;
  document.getElementById('rp-me-avatar').textContent     = myProfile.avatar;
  document.getElementById('rp-me-name').textContent       = myProfile.nickname;
  document.getElementById('rp-opp-avatar').textContent    = opp.avatar || '❓';
  document.getElementById('rp-opp-name').textContent      = opp.name   || 'Adversário';
  document.getElementById('rp-me-wins').textContent       = rMyWins  + ' vitória' + (rMyWins  !== 1 ? 's' : '');
  document.getElementById('rp-opp-wins').textContent      = rOppWins + ' vitória' + (rOppWins !== 1 ? 's' : '');
  document.getElementById('rp-me-score').textContent      = '—';
  document.getElementById('rp-opp-score').textContent     = '—';
  document.getElementById('ranked-status').textContent    = '';

  const timerEl = document.getElementById('ranked-timer');
  timerEl.textContent = '0.00';
  timerEl.className   = 'timer-display idle';
  document.getElementById('ranked-hint').innerHTML = 'segure <kbd>espaço</kbd> para iniciar';

  rMyDone  = false;
  rOppDone = false;
  rMyTime  = null;
  rankedTimerState = 'idle';

  document.removeEventListener('keydown', rankedKeyDown);
  document.removeEventListener('keyup',   rankedKeyUp);
  document.addEventListener('keydown', rankedKeyDown);
  document.addEventListener('keyup',   rankedKeyUp);

  rankedPollId = setInterval(pollRankedRound, 2000);
}

async function pollRankedRound() {
  if (!rankedMatch) return;
  const room = await sbGetRankedMatch(rankedMatch.id);
  if (!room) { leaveRanked(); return; }
  rankedMatch = room;

  const results = await sbGetRankedResults(rankedMatch.id, rankedMatch.round);
  if (!Array.isArray(results)) return;

  const myId   = MY_ID;
  const oppId  = rankedIsHost ? rankedMatch.guest_id : rankedMatch.host_id;
  const myRes  = results.find(r => r.player_id === myId);
  const oppRes = results.find(r => r.player_id === oppId);

  if (myRes) {
    document.getElementById('rp-me-score').textContent  = fmtTime(myRes.time_ms);
    document.getElementById('rp-me-score').className    = 'bp-score done';
  }
  if (oppRes) {
    document.getElementById('rp-opp-score').textContent = fmtTime(oppRes.time_ms);
    document.getElementById('rp-opp-score').className   = 'bp-score done';
    rOppDone = true;
  }

  // Ambos terminaram: processa round
  if (myRes && oppRes && !rOppDone) return;
  if (myRes && oppRes) {
    clearInterval(rankedPollId);
    document.removeEventListener('keydown', rankedKeyDown);
    document.removeEventListener('keyup',   rankedKeyUp);

    const iWon = myRes.time_ms < oppRes.time_ms;
    if (iWon) rMyWins++; else rOppWins++;

    document.getElementById('rp-me-wins').textContent  = rMyWins  + ' vitória' + (rMyWins  !== 1 ? 's' : '');
    document.getElementById('rp-opp-wins').textContent = rOppWins + ' vitória' + (rOppWins !== 1 ? 's' : '');

    const statusEl = document.getElementById('ranked-status');
    statusEl.textContent = iWon ? '🟢 Você venceu este round!' : '🔴 Adversário venceu este round.';

    // MD1 → fim imediato
    setTimeout(() => finishRankedMatch(iWon), 2000);
  }
}

async function finishRankedMatch(iWon) {
  clearInterval(rankedPollId);
  document.removeEventListener('keydown', rankedKeyDown);
  document.removeEventListener('keyup',   rankedKeyUp);

  // Atualiza troféus
  if (!myRankedProfile) await loadMyRankedProfile();
  const delta   = iWon ? RANKED_WIN_TROPHIES : -RANKED_LOSS_TROPHIES;
  const newTroph = Math.max(0, myRankedProfile.trophies + delta);
  const newWins  = myRankedProfile.total_wins   + (iWon ? 1 : 0);
  const newLoss  = myRankedProfile.total_losses + (iWon ? 0 : 1);

  await sbUpsertRankedProfile(newTroph, newWins, newLoss);
  myRankedProfile = { ...myRankedProfile, trophies: newTroph, total_wins: newWins, total_losses: newLoss };

  // Incrementa histórico de confronto
  const oppId = rankedIsHost ? rankedMatch.guest_id : rankedMatch.host_id;
  const newCount = await getMatchCountBetween(MY_ID, oppId);
  if (newCount + 1 >= RANKED_MAX_REMATCHES) {
    // Reseta após atingir o limite
    await resetMatchCountBetween(MY_ID, oppId);
  } else {
    await incrementMatchCount(MY_ID, oppId);
  }

  // Deleta partida
  await sbDelete('ranked_matches', `id=eq.${rankedMatch.id}`);
  rankedMatch = null;

  // Mostra resultado
  showRankedResult(iWon, delta, newTroph);
  updateRankedProfileUI(myRankedProfile);
}

function showRankedResult(iWon, delta, totalTrophies) {
  document.getElementById('ranked-arena').style.display  = 'none';
  document.getElementById('ranked-lobby').style.display  = 'flex';
  document.getElementById('ranked-result').style.display = 'flex';
  document.getElementById('ranked-search-area').style.display    = 'none';
  document.getElementById('ranked-searching').style.display      = 'none';
  document.querySelector('.ranked-tabs').style.display           = 'none';

  const resultEl = document.getElementById('ranked-result');
  resultEl.className = 'battle-section ' + (iWon ? 'ranked-result-win' : 'ranked-result-loss');

  document.getElementById('ranked-result-icon').textContent     = iWon ? '🏆' : '💔';
  document.getElementById('ranked-result-title').textContent    = iWon ? 'Vitória!' : 'Derrota';
  document.getElementById('ranked-result-sub').textContent      = iWon
    ? 'Você foi mais rápido! Troféus ganhos:'
    : 'O adversário foi mais rápido. Troféus perdidos:';
  document.getElementById('ranked-result-trophies').textContent = (iWon ? '+' : '') + delta + ' 🏆';
  document.getElementById('ranked-result-total').textContent    = `Total: ${totalTrophies} troféus`;
}

// ── Timer ranked ───────────────────────────────
function rankedPressDown() {
  if (rankedTimerState !== 'idle') return;
  rankedHoldReady = false;
  document.getElementById('ranked-timer').className = 'timer-display holding';
  rankedHoldTimer = setTimeout(() => {
    rankedHoldReady = true;
    document.getElementById('ranked-timer').className = 'timer-display ready';
  }, cfg.holdTime || 300);
}

function rankedPressUp() {
  clearTimeout(rankedHoldTimer);
  if (rankedTimerState === 'idle' && rankedHoldReady) {
    rankedTimerState = 'running';
    rankedStart = Date.now();
    document.getElementById('ranked-hint').textContent = 'solte para parar';
    const tick = () => {
      if (rankedTimerState !== 'running') return;
      document.getElementById('ranked-timer').textContent = fmtTime(Date.now() - rankedStart);
      rankedRafId = requestAnimationFrame(tick);
    };
    rankedRafId = requestAnimationFrame(tick);
  } else if (rankedTimerState === 'running') {
    cancelAnimationFrame(rankedRafId);
    const t = Date.now() - rankedStart;
    rankedTimerState = 'done';
    rMyDone  = true;
    rMyTime  = t;
    document.getElementById('ranked-timer').textContent = fmtTime(t);
    document.getElementById('ranked-timer').className   = 'timer-display idle';
    document.getElementById('ranked-hint').textContent  = 'aguardando adversário...';
    document.getElementById('ranked-status').textContent = '✅ Tempo enviado. Aguardando adversário...';
    sbInsertRankedResult(rankedMatch.id, MY_ID, rankedMatch.round || 1, t);
    rOppDone = false; // reseta flag para o poll
  } else {
    document.getElementById('ranked-timer').className = 'timer-display idle';
  }
}

function rankedKeyDown(e) {
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); rankedPressDown(); }
}
function rankedKeyUp(e) {
  if (e.code === 'Space') { e.preventDefault(); rankedPressUp(); }
}

// ── Toque mobile ranked ───────────────────────
function rankedTouchStart(e) { e.preventDefault(); rankedPressDown(); }
function rankedTouchEnd(e)   { e.preventDefault(); rankedPressUp(); }

// ── Navegação ranked ───────────────────────────
async function showRankedLobby() {
  document.getElementById('ranked-lobby').style.display  = 'flex';
  document.getElementById('ranked-arena').style.display  = 'none';
  document.getElementById('ranked-result').style.display = 'none';
  document.getElementById('ranked-search-area').style.display     = 'block';
  document.getElementById('ranked-searching').style.display       = 'none';
  document.querySelector('.ranked-tabs').style.display            = 'flex';
  document.getElementById('ranked-tab-leaderboard').style.display = 'block';
  document.getElementById('ranked-tab-history').style.display     = 'none';
  document.querySelectorAll('.ranked-tab').forEach((t,i) => t.classList.toggle('active', i===0));

  const p = await loadMyRankedProfile();
  updateRankedProfileUI(p);
  loadLeaderboard();
}

async function leaveRanked() {
  clearInterval(rankedPollId);
  clearInterval(rankedSearchTimer);
  cancelAnimationFrame(rankedRafId);
  document.removeEventListener('keydown', rankedKeyDown);
  document.removeEventListener('keyup',   rankedKeyUp);
  if (rankedMatch) {
    await sbDelete('ranked_matches', `id=eq.${rankedMatch.id}`);
    rankedMatch = null;
  }
  await sbDelete('ranked_queue', `id=eq.${MY_ID}`);
  showPage('timer');
}

// ── Leaderboard global ─────────────────────────
async function loadLeaderboard() {
  const el = document.getElementById('ranked-leaderboard');
  if (!el) return;
  el.innerHTML = '<div class="ranked-loading">Carregando ranking...</div>';
  const rows = await sbGet('ranked_profiles', 'order=trophies.desc&limit=50');
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = '<div class="ranked-loading">Nenhum jogador ranqueado ainda.</div>';
    return;
  }
  el.innerHTML = rows.map((r, i) => {
    const pos     = i + 1;
    const isMe    = r.id === MY_ID;
    const posClass = pos === 1 ? 'top1' : pos === 2 ? 'top2' : pos === 3 ? 'top3' : '';
    const posLabel = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;
    const total   = r.total_wins + r.total_losses;
    const wr      = total > 0 ? Math.round(r.total_wins / total * 100) : 0;
    return `<div class="ranked-lb-row ${isMe ? 'is-me' : ''}">
      <div class="ranked-lb-pos ${posClass}">${posLabel}</div>
      <div class="ranked-lb-player">
        <span class="ranked-lb-avatar">${r.avatar || '🧊'}</span>
        <div>
          <div class="ranked-lb-name">${r.nickname || 'Cuber'}${isMe ? ' <span style="color:var(--accent);font-size:10px;">(você)</span>' : ''}</div>
          <div class="ranked-lb-record">${r.total_wins}V · ${r.total_losses}D</div>
        </div>
      </div>
      <div class="ranked-lb-wr">${wr}% WR</div>
      <div class="ranked-lb-trophies">🏆 ${r.trophies}</div>
    </div>`;
  }).join('');
}

async function loadRankedHistory() {
  const el = document.getElementById('ranked-history-list');
  if (!el) return;
  el.innerHTML = '<div class="ranked-loading">Carregando...</div>';
  // Busca histórico de confrontos do jogador
  const [asA, asB] = await Promise.all([
    sbGet('ranked_history', `player_a=eq.${MY_ID}&order=last_match.desc&limit=20`),
    sbGet('ranked_history', `player_b=eq.${MY_ID}&order=last_match.desc&limit=20`)
  ]);
  const all = [...(Array.isArray(asA) ? asA : []), ...(Array.isArray(asB) ? asB : [])]
    .sort((a, b) => new Date(b.last_match) - new Date(a.last_match))
    .slice(0, 20);

  if (!all.length) {
    el.innerHTML = '<div class="ranked-loading">Nenhum confronto registrado ainda.</div>';
    return;
  }

  // Busca perfis dos adversários
  const oppIds = [...new Set(all.map(r => r.player_a === MY_ID ? r.player_b : r.player_a))];
  const profiles = await sbGet('ranked_profiles', `id=in.(${oppIds.join(',')})&limit=20`);
  const profileMap = {};
  if (Array.isArray(profiles)) profiles.forEach(p => profileMap[p.id] = p);

  el.innerHTML = all.map(r => {
    const oppId   = r.player_a === MY_ID ? r.player_b : r.player_a;
    const opp     = profileMap[oppId] || { nickname: 'Cuber', avatar: '🧊' };
    const date    = new Date(r.last_match).toLocaleDateString('pt-BR');
    const remaining = RANKED_MAX_REMATCHES - r.match_count;
    return `<div class="ranked-lb-row">
      <div class="ranked-lb-avatar">${opp.avatar || '🧊'}</div>
      <div class="ranked-lb-player" style="flex-direction:column;align-items:flex-start;gap:2px;">
        <div class="ranked-lb-name">${opp.nickname || 'Cuber'}</div>
        <div class="ranked-lb-record">${r.match_count} partida${r.match_count !== 1 ? 's' : ''} · ${date}</div>
      </div>
      <div class="ranked-lb-wr" style="font-size:10px;">${remaining > 0 ? remaining + ' restante' + (remaining !== 1 ? 's' : '') : 'resetado'}</div>
      <div class="ranked-lb-trophies" style="font-size:12px;color:var(--muted);">🏆 ${opp.trophies ?? '—'}</div>
    </div>`;
  }).join('');
}

function switchRankedTab(tab) {
  document.querySelectorAll('.ranked-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'leaderboard') || (i === 1 && tab === 'history'));
  });
  document.getElementById('ranked-tab-leaderboard').style.display = tab === 'leaderboard' ? 'block' : 'none';
  document.getElementById('ranked-tab-history').style.display     = tab === 'history'     ? 'block' : 'none';
  if (tab === 'leaderboard') loadLeaderboard();
  else loadRankedHistory();
}
