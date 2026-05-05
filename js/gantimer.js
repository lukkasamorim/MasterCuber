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

function handleStackmatPacket(packet) {
  const { status, totalMs, running, stopped, hands } = packet;

  // Atualiza display do painel
  updateGanTimerDisplay(totalMs, status);

  // Detecta transição rodando → parado (solve completo)
  if (ganWasRunning && stopped && totalMs > 0) {
    ganWasRunning = false;
    ganLastMs = totalMs;
    onGanTimerStopped(totalMs);
    return;
  }

  if (running) {
    ganWasRunning = true;
    ganLastMs = totalMs;

    // Sincroniza o timer do app se estiver idle
    if (typeof timerState !== 'undefined') {
      if (timerState === STATE.IDLE || timerState === STATE.INSPECTION) {
        startGanTimerSync();
      }
    }
  }

  // Mãos no pad → reseta estado
  if (hands && totalMs === 0) {
    ganWasRunning = false;
    if (typeof timerState !== 'undefined' && timerState === STATE.IDLE) {
      updateGanTimerState('mãos detectadas...');
    }
  }

  ganLastState = packet;
}

// ── Sincronização com o timer do app ──────────
let ganSyncRaf = null;

function startGanTimerSync() {
  // Exibe o tempo do GAN diretamente no timer principal
  if (ganSyncRaf) return;

  const tick = () => {
    if (!ganConnected || !ganWasRunning) { ganSyncRaf = null; return; }
    if (ganLastState) {
      if (typeof elTimer !== 'undefined') {
        elTimer.textContent = fmtTime(ganLastMs);
        elTimer.className   = 'timer-display running';
      }
    }
    ganSyncRaf = requestAnimationFrame(tick);
  };
  ganSyncRaf = requestAnimationFrame(tick);
}

function onGanTimerStopped(totalMs) {
  cancelAnimationFrame(ganSyncRaf);
  ganSyncRaf = null;

  if (typeof elTimer !== 'undefined') {
    showTimerWithDelta(totalMs);
    elTimer.className = 'timer-display idle';
  }

  if (typeof setFocusMode !== 'undefined') setFocusMode(false);

  if (ganSaveOnStop && typeof saveTime !== 'undefined' && totalMs > 0) {
    saveTime(totalMs);
    showToast('⏱ GAN Timer: ' + fmtTime(totalMs));
  }

  updateGanTimerState('tempo registrado');
}

// ── UI do painel ───────────────────────────────
function updateGanTimerDisplay(ms, status) {
  const el = document.getElementById('gan-timer-display');
  if (el) el.textContent = ms > 0 ? fmtTime(ms) : '0.00';
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
    showToast('Web Serial não suportado. Use Chrome 89+ no desktop.');
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
    showToast('✅ GAN Timer conectado!');

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
      showToast('Erro ao conectar: ' + err.message);
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
      showToast('GAN Timer desconectado inesperadamente.');
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
  showToast('GAN Timer desconectado.');
  const panel = document.getElementById('gan-timer-panel');
  if (panel) panel.style.display = 'none';
  stackmatBuffer = [];
}

// ── Menu de dispositivos ───────────────────────
function toggleDeviceMenu() {
  const menu = document.getElementById('device-connect-menu');
  if (!menu) return;
  const open = menu.style.display === 'none' || !menu.style.display;
  menu.style.display = open ? 'block' : 'none';
  if (open) {
    // Fecha ao clicar fora
    setTimeout(() => {
      document.addEventListener('click', closeDeviceMenuOnOutside, { once: true });
    }, 0);
  }
}

function closeDeviceMenu() {
  const menu = document.getElementById('device-connect-menu');
  if (menu) menu.style.display = 'none';
}

function closeDeviceMenuOnOutside(e) {
  const wrapper = document.getElementById('device-connect-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeDeviceMenu();
}

function updateDeviceButtonLabel() {
  const label  = document.getElementById('btn-device-label');
  const dot    = document.getElementById('cube-bt-dot');
  if (!label) return;

  const smartOk = typeof cubeConnected !== 'undefined' && cubeConnected;
  const ganOk   = ganConnected;

  if (smartOk && ganOk) {
    label.textContent = '🟢 2 dispositivos';
    dot.style.background = '#4adb8a';
  } else if (smartOk) {
    label.textContent = '🟢 Smart Cube';
    dot.style.background = '#4adb8a';
  } else if (ganOk) {
    label.textContent = '🟢 GAN Timer';
    dot.style.background = '#4adb8a';
  } else {
    label.textContent = '🔌 Dispositivo';
    dot.style.background = 'var(--muted)';
  }
}

function updateDisconnectBtn() {
  const btn = document.getElementById('btn-disconnect-all');
  if (!btn) return;
  const anyConnected = ganConnected || (typeof cubeConnected !== 'undefined' && cubeConnected);
  btn.style.display = anyConnected ? 'flex' : 'none';
}

function disconnectAllDevices() {
  if (typeof disconnectSmartCube !== 'undefined' && typeof cubeConnected !== 'undefined' && cubeConnected) {
    disconnectSmartCube();
  }
  if (ganConnected) disconnectGanTimer();
  updateDeviceButtonLabel();
  updateDisconnectBtn();
}

// ── Integração com bluetooth.js ────────────────
// Sobrescreve setCubeStatus para também atualizar o label unificado
const _origSetCubeStatus = typeof setCubeStatus !== 'undefined' ? setCubeStatus : null;
window.addEventListener('load', () => {
  // Patch no setCubeStatus original para sincronizar o dot do smart cube
  const smartDot = document.getElementById('smartcube-status-dot');
  if (smartDot) {
    // Observer que atualiza o smartcube-status-dot sempre que cubeConnected mudar
    const checkInterval = setInterval(() => {
      if (typeof cubeConnected === 'undefined') return;
      smartDot.style.background = cubeConnected ? '#4adb8a' : 'var(--muted)';
      updateDeviceButtonLabel();
      updateDisconnectBtn();
    }, 1000);
  }
});
