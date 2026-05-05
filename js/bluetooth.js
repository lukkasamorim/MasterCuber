// ═══════════════════════════════════════════════
//  GAN TIMER — Web Serial API (Stackmat Protocol)
//  Compatível com: GAN Timer (Gen 1, Gen 2, Gen 3)
//  Protocolo: Stackmat S3/S4 (9600 baud, 8N1)
//  Ref: https://github.com/jfly/stackmat
// ═══════════════════════════════════════════════

let ganPort         = null;
let ganReader       = null;
let ganConnected    = false;
let ganReadLoop     = null;
let ganLastState    = null;   // último estado do timer
let ganLastMs       = 0;      // último tempo registrado
let ganWasRunning   = false;  // estava rodando no tick anterior
let ganSaveOnStop   = true;   // salva automaticamente quando para

// ── Protocolo Stackmat ─────────────────────────
// Pacote de 9 bytes:
// [status, d1, d2, d3, d4, d5, d6, checksum, CR/LF]
//
// status byte:
//   'I' = parado em 0 (idle reset)
//   'S' = parado com tempo (stopped)
//   'R' = rodando (running)
//   'L' = mão esquerda no pad
//   'C' = mão direita no pad (contact)
//   'A' = ambas as mãos
//   ' ' = nenhuma mão (estado geral parado)
//
// d1..d6 = dígitos ASCII do tempo (MM:SS.cc)
// checksum = 64 + soma dos dígitos

const STACKMAT_BAUD = 9600;
const STACKMAT_RUNNING_STATES = new Set(['R']);
const STACKMAT_STOPPED_STATES = new Set(['S', ' ', 'I']);
const STACKMAT_HANDS_STATES   = new Set(['L', 'C', 'A']);

let stackmatBuffer = [];

function parseStackmatPacket(buf) {
  // Precisa de pelo menos 9 bytes
  if (buf.length < 9) return null;

  // Procura por um pacote válido no buffer
  for (let i = 0; i <= buf.length - 9; i++) {
    const status = String.fromCharCode(buf[i]);
    const validStatus = 'ISRLCAi ';
    if (!validStatus.includes(status)) continue;

    // Dígitos devem ser ASCII 0-9
    const digits = buf.slice(i + 1, i + 7);
    if (!digits.every(b => b >= 48 && b <= 57)) continue;

    // Verifica checksum: 64 + soma dos dígitos
    const expectedCheck = 64 + digits.reduce((a, b) => a + b, 0);
    const actualCheck   = buf[i + 7];
    if (actualCheck !== (expectedCheck & 0xFF)) continue;

    // Pacote válido!
    const [d1, d2, d3, d4, d5, d6] = digits.map(b => b - 48);
    // Formato: d1 = minutos, d2d3 = segundos, d4d5d6 = milissegundos
    const minutes = d1;
    const seconds = d2 * 10 + d3;
    const ms      = (d4 * 100 + d5 * 10 + d6) * 10; // centésimos → ms

    const totalMs = (minutes * 60 + seconds) * 1000 + ms;

    return {
      status,
      totalMs,
      running : STACKMAT_RUNNING_STATES.has(status),
      stopped : STACKMAT_STOPPED_STATES.has(status),
      hands   : STACKMAT_HANDS_STATES.has(status),
      raw     : buf.slice(i, i + 9),
    };
  }
  return null;
}

function processGanTimerData(bytes) {
  // Acumula bytes no buffer
  stackmatBuffer.push(...bytes);

  // Tenta extrair pacotes (cada um tem 9 bytes terminados em 0x0A ou 0x0D)
  // GAN timer envia ~10 pacotes/segundo
  while (stackmatBuffer.length >= 9) {
    const packet = parseStackmatPacket(stackmatBuffer);
    if (packet) {
      handleStackmatPacket(packet);
      // Remove até o final do pacote processado
      const idx = stackmatBuffer.findIndex((b, i) => {
        const s = String.fromCharCode(b);
        return 'ISRLCAi '.includes(s) && stackmatBuffer.slice(i + 1, i + 7).every(x => x >= 48 && x <= 57);
      });
      if (idx >= 0) {
        stackmatBuffer.splice(0, idx + 9);
      } else {
        stackmatBuffer.splice(0, 9);
      }
    } else {
      // Remove byte inválido e tenta de novo
      stackmatBuffer.shift();
    }
  }

  // Evita buffer crescer indefinidamente
  if (stackmatBuffer.length > 100) stackmatBuffer.splice(0, stackmatBuffer.length - 50);
}

// ── Helpers: acessa funções do app.js via window ──
function _appEl()      { return window.elTimer; }
function _appFmt(ms)   { return window.fmtTime   ? window.fmtTime(ms)   : (ms/1000).toFixed(2); }
function _appSave(t)   { if (window.saveTime)           window.saveTime(t); }
function _appDelta(t)  { if (window.showTimerWithDelta) window.showTimerWithDelta(t); }
function _appFocus(on) { if (window.setFocusMode)       window.setFocusMode(on); }
function _appState()   { return window.timerState; }
function _appSTATE()   { return window.STATE || { IDLE:'idle', RUNNING:'running', INSPECTION:'inspection' }; }

// flag: GAN está no controle do timer (não deixa teclado interferir)
let ganIsControlling = false;
let ganSyncRaf = null;

function handleStackmatPacket(packet) {
  if (!ganConnected) return;

  const { status, totalMs, running, stopped, hands } = packet;
  const STATE    = _appSTATE();
  const curState = _appState();

  // Painel lateral sempre atualizado
  updateGanTimerDisplay(totalMs, status);

  // ── RODANDO → PARADO: solve completa ──
  if (ganWasRunning && stopped && totalMs > 0) {
    ganWasRunning    = false;
    ganIsControlling = false;
    ganLastMs        = totalMs;
    onGanTimerStopped(totalMs);
    ganLastState = packet;
    return;
  }

  // ── Começou a rodar ──
  if (running && !ganWasRunning) {
    if (curState === STATE.IDLE || curState === STATE.INSPECTION) {
      ganWasRunning    = true;
      ganIsControlling = true;
      ganLastMs        = totalMs;
      updateGanTimerState('rodando...');
      startGanTimerSync();
    }
  } else if (running && ganWasRunning) {
    ganLastMs = totalMs;
  }

  // ── Mãos no pad ──
  if (hands) {
    ganWasRunning = false;
    updateGanTimerState('pronto...');
    if (ganIsControlling && curState === STATE.IDLE) {
      const el = _appEl();
      if (el) { el.textContent = '0.00'; el.className = 'timer-display idle'; el.style.color = ''; }
    }
  }

  // ── Reset ──
  if (status === 'I' || (stopped && totalMs === 0)) {
    ganWasRunning    = false;
    ganIsControlling = false;
    updateGanTimerState('aguardando...');
  }

  ganLastState = packet;
}

function startGanTimerSync() {
  if (ganSyncRaf) return;
  const tick = () => {
    if (!ganConnected || !ganWasRunning) { ganSyncRaf = null; return; }
    const el = _appEl();
    if (el) {
      el.textContent = _appFmt(ganLastMs);
      el.className   = 'timer-display running';
      el.style.color = '';
    }
    ganSyncRaf = requestAnimationFrame(tick);
  };
  ganSyncRaf = requestAnimationFrame(tick);
}

function onGanTimerStopped(totalMs) {
  cancelAnimationFrame(ganSyncRaf);
  ganSyncRaf = null;

  const el = _appEl();
  if (el) {
    _appDelta(totalMs);
    el.className   = 'timer-display idle';
    el.style.color = '';
  }

  _appFocus(false);

  if (ganSaveOnStop && totalMs > 0) {
    _appSave(totalMs); // saveTime já chama newScramble + showToast + renderAll
  }

  updateGanTimerState('✅ tempo salvo');
}

// ── UI do painel ───────────────────────────────
function updateGanTimerDisplay(ms, status) {
  const el = document.getElementById('gan-timer-display');
  if (el) el.textContent = ms > 0 ? _appFmt(ms) : '0.00';
}

function updateGanTimerState(text) {
  const el = document.getElementById('gan-timer-state');
  if (el) el.textContent = text;
}

function setGanStatus(text, color) {
  const dot   = document.getElementById('gantimer-status-dot');
  const label = document.getElementById('btn-device-label');
  if (dot) dot.style.background = color || 'var(--muted)';
}

// ── Conexão via Web Serial ─────────────────────
async function connectGanTimer() {
  if (!('serial' in navigator)) {
    if(window.showToast) window.showToast('Web Serial não suportado. Use Chrome 89+ no desktop.');
    return;
  }

  if (ganConnected) {
    disconnectGanTimer();
    return;
  }

  try {
    setGanStatus('Conectando...', '#7dd3fc');

    // Solicita porta serial ao usuário
    // GAN Timer aparece como CP210x ou CH340 USB-Serial
    ganPort = await navigator.serial.requestPort({
      filters: [
        { usbVendorId: 0x10C4 }, // Silicon Labs CP210x (GAN Gen1/Gen2)
        { usbVendorId: 0x1A86 }, // CH340 (GAN Gen3 e clones)
        { usbVendorId: 0x0403 }, // FTDI (alguns modelos)
      ]
    });

    await ganPort.open({
      baudRate: STACKMAT_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity  : 'none',
      flowControl: 'none',
    });

    ganConnected = true;
    stackmatBuffer = [];
    ganWasRunning  = false;
    ganLastState   = null;

    setGanStatus('🟢', '#4adb8a');
    updateDeviceButtonLabel();
    if(window.showToast) window.showToast('✅ GAN Timer conectado!');

    // Mostra painel
    const panel = document.getElementById('gan-timer-panel');
    if (panel) panel.style.display = 'flex';

    // Atualiza botão desconectar
    updateDisconnectBtn();

    // Loop de leitura
    ganReader = ganPort.readable.getReader();
    ganReadLoop = readGanTimerLoop();

  } catch (err) {
    ganConnected = false;
    setGanStatus('', 'var(--muted)');
    if (err.name !== 'NotFoundError') {
      if(window.showToast) window.showToast('Erro ao conectar: ' + err.message);
      console.error('[GAN]', err);
    }
  }
}

async function readGanTimerLoop() {
  try {
    while (ganConnected) {
      const { value, done } = await ganReader.read();
      if (done) break;
      if (value) processGanTimerData(Array.from(value));
    }
  } catch (err) {
    if (ganConnected) {
      console.error('[GAN] Erro de leitura:', err);
      if(window.showToast) window.showToast('GAN Timer desconectado inesperadamente.');
      onGanTimerDisconnected();
    }
  } finally {
    try { ganReader.releaseLock(); } catch(e) {}
  }
}

async function disconnectGanTimer() {
  ganConnected = false;
  cancelAnimationFrame(ganSyncRaf);
  ganSyncRaf = null;

  try {
    if (ganReader) { await ganReader.cancel(); ganReader = null; }
  } catch(e) {}

  try {
    if (ganPort) { await ganPort.close(); ganPort = null; }
  } catch(e) {}

  onGanTimerDisconnected();
}

function onGanTimerDisconnected() {
  ganConnected = false;
  setGanStatus('', 'var(--muted)');
  updateDeviceButtonLabel();
  updateDisconnectBtn();
  if(window.showToast) window.showToast('GAN Timer desconectado.');
  const panel = document.getElementById('gan-timer-panel');
  if (panel) panel.style.display = 'none';
  stackmatBuffer = [];
}

// ── Integração com bluetooth.js ────────────────
// Sincroniza o dot do smart cube no submenu a cada segundo
window.addEventListener('load', () => {
  setInterval(() => {
    const smartDot = document.getElementById('smartcube-status-dot');
    if (smartDot && typeof cubeConnected !== 'undefined') {
      smartDot.style.background = cubeConnected ? '#4adb8a' : 'var(--muted)';
    }
    if (typeof updateDeviceButtonLabel !== 'undefined') updateDeviceButtonLabel();
    if (typeof updateDisconnectBtn     !== 'undefined') updateDisconnectBtn();
  }, 1000);
});
