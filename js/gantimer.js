// ═══════════════════════════════════════════════
//  GAN HALO TIMER — Web Bluetooth API
//  Protocolo GAN BLE documentado por afedotov
//  Ref: gist.github.com/afedotov/a025fa5796c9c727b04cf98b293a02f6
//
//  Serviço:    0000fff0-0000-1000-8000-00805f9b34fb
//  Notify:     0000fff5-0000-1000-8000-00805f9b34fb (estados do timer)
//  Read:       0000fff2-0000-1000-8000-00805f9b34fb (tempos armazenados)
// ═══════════════════════════════════════════════

const GAN_SERVICE  = '0000fff0-0000-1000-8000-00805f9b34fb';
const GAN_NOTIFY   = '0000fff5-0000-1000-8000-00805f9b34fb';
const GAN_READ     = '0000fff2-0000-1000-8000-00805f9b34fb';

// Estados do timer
const GAN_STATE = {
  GET_SET  : 0x01,
  HANDS_OFF: 0x02,
  RUNNING  : 0x03,
  STOPPED  : 0x04,
  IDLE     : 0x05,
  HANDS_ON : 0x06,
  FINISHED : 0x07,
};

let ganDevice      = null;
let ganChar        = null;
let ganConnected   = false;
let ganLastStateId = null;

// ── CRC-16/CCITT-FALSE ──────────────────────────
// Polinômio 0x1021, valor inicial 0xFFFF
function crc16ccitt(data) {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// ── Parser do pacote ─────────────────────────────
// Formato: FE [len] [01] [state] [time?...] [crc_hi] [crc_lo]
function parseGanPacket(data) {
  const b = new Uint8Array(data.buffer || data);
  if (b.length < 4) return null;
  if (b[0] !== 0xFE) return null;

  const dataLen  = b[1];         // comprimento dos bytes de dados
  const dataBytes = b.slice(2, 2 + dataLen - 2); // dados sem CRC
  const crcBytes  = b.slice(2 + dataLen - 2, 2 + dataLen);

  // Verifica CRC
  const expectedCrc = crc16ccitt(dataBytes);
  const actualCrc   = (crcBytes[0] << 8) | crcBytes[1];
  if (expectedCrc !== actualCrc) {
    console.warn('[GAN] CRC inválido — esperado:', expectedCrc.toString(16), 'recebido:', actualCrc.toString(16));
    // Continua mesmo assim — alguns firmwares têm quirks
  }

  if (dataBytes[0] !== 0x01) return null; // prefixo de dados esperado

  const state = dataBytes[1];

  // Tempo presente apenas nos estados STOPPED (0x04) e IDLE (0x05)
  let timeMs = null;
  if ((state === GAN_STATE.STOPPED || state === GAN_STATE.IDLE) && dataBytes.length >= 6) {
    const minutes = dataBytes[2];
    const seconds = dataBytes[3];
    const ms      = dataBytes[4] | (dataBytes[5] << 8); // uint16le
    timeMs = (minutes * 60 + seconds) * 1000 + ms;
  }

  return { state, timeMs };
}

// ── Handler de eventos ───────────────────────────
function onGanTimerEvent(event) {
  const packet = parseGanPacket(event.target.value);
  if (!packet) return;

  const { state, timeMs } = packet;
  const stateName = Object.keys(GAN_STATE).find(k => GAN_STATE[k] === state) || '?';
  console.log(`[GAN] Estado: ${stateName}${timeMs != null ? ' | Tempo: ' + appFmt(timeMs) : ''}`);

  updateGanPanelState(stateName);

  switch (state) {
    case GAN_STATE.HANDS_ON:
      // Mãos no pad — prepara o timer visual
      updateGanPanelTime(0);
      updateGanPanelState('Pronto...');
      break;

    case GAN_STATE.HANDS_OFF:
      updateGanPanelState('Aguardando...');
      break;

    case GAN_STATE.GET_SET:
      updateGanPanelState('Preparar!');
      break;

    case GAN_STATE.RUNNING:
      // Timer físico iniciou — reseta o display mas não controla o timer do app
      // O tempo real vem do STOPPED
      updateGanPanelState('Rodando...');
      break;

    case GAN_STATE.STOPPED:
      if (timeMs != null && timeMs > 0) {
        updateGanPanelTime(timeMs);
        updateGanPanelState('✅ Salvo!');
        onGanTimerStopped(timeMs);
      }
      break;

    case GAN_STATE.FINISHED:
      // Estado automático após STOPPED — ignora
      break;

    case GAN_STATE.IDLE:
      updateGanPanelState('Aguardando...');
      updateGanPanelTime(0);
      break;
  }

  ganLastStateId = state;
}

function onGanTimerStopped(timeMs) {
  // Mostra o tempo no display principal com delta
  if (window.showTimerWithDelta) {
    window.showTimerWithDelta(timeMs);
  } else if (window.elTimer) {
    window.elTimer.textContent = appFmt(timeMs);
  }

  if (window.setFocusMode) window.setFocusMode(false);

  // Salva o tempo no histórico
  if (window.saveTime) {
    window.saveTime(timeMs);
  }
}

// ── UI do painel ─────────────────────────────────
function updateGanPanelTime(ms) {
  const el = document.getElementById('gan-timer-display');
  if (el) el.textContent = ms > 0 ? appFmt(ms) : '0.00';
}

function updateGanPanelState(text) {
  const el = document.getElementById('gan-timer-state');
  if (el) el.textContent = text;
}

function setGanDot(color) {
  const dot  = document.getElementById('gantimer-status-dot');
  const dot2 = document.getElementById('gan-timer-dot-panel');
  if (dot)  dot.style.background  = color;
  if (dot2) dot2.style.background = color;
}

// ── Helpers seguros para acessar o app.js ────────
function appFmt(ms)   { return window.fmtTime   ? window.fmtTime(ms)   : (ms / 1000).toFixed(2); }
function appToast(msg){ if (window.showToast)    window.showToast(msg); }

// ── Conexão Bluetooth ────────────────────────────
async function connectGanTimer() {
  if (!navigator.bluetooth) {
    appToast('Web Bluetooth não suportado. Use Chrome ou Edge.');
    return;
  }

  if (ganConnected) {
    disconnectGanTimer();
    return;
  }

  try {
    setGanDot('#7dd3fc');
    updateDeviceButtonLabel?.();

    ganDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'GAN-ST' },   // GAN Smart Timer (ex: GAN-STv4357)
        { namePrefix: 'GAN-' },
        { namePrefix: 'GAN_' },
        { namePrefix: 'Halo' },
      ],
      optionalServices: [GAN_SERVICE],
    });

    ganDevice.addEventListener('gattserverdisconnected', onGanDisconnected);

    const server  = await ganDevice.gatt.connect();
    const service = await server.getPrimaryService(GAN_SERVICE);
    ganChar       = await service.getCharacteristic(GAN_NOTIFY);

    await ganChar.startNotifications();
    ganChar.addEventListener('characteristicvaluechanged', onGanTimerEvent);

    ganConnected = true;
    const name = ganDevice.name || 'GAN Timer';
    setGanDot('#4adb8a');
    appToast('✅ ' + name + ' conectado!');
    console.log('[GAN] Conectado:', name);

    // Mostra painel
    const panel = document.getElementById('gan-timer-panel');
    if (panel) panel.style.display = 'flex';

    updateDeviceButtonLabel?.();
    updateDisconnectBtn?.();

  } catch(err) {
    ganConnected = false;
    setGanDot('var(--muted)');
    console.error('[GAN] Erro:', err);
    if (err.name !== 'NotFoundError') {
      appToast('Erro ao conectar GAN Timer: ' + err.message);
    }
    updateDeviceButtonLabel?.();
  }
}

function disconnectGanTimer() {
  if (ganDevice?.gatt?.connected) {
    ganDevice.gatt.disconnect();
  }
  onGanDisconnected();
}

function onGanDisconnected() {
  ganConnected = false;
  ganChar      = null;
  setGanDot('var(--muted)');
  appToast('GAN Timer desconectado.');
  console.log('[GAN] Desconectado.');

  const panel = document.getElementById('gan-timer-panel');
  if (panel) panel.style.display = 'none';

  updateDeviceButtonLabel?.();
  updateDisconnectBtn?.();
}

// ── Sync do status dot no submenu ────────────────
window.addEventListener('load', () => {
  setInterval(() => {
    const dot = document.getElementById('gantimer-status-dot');
    if (dot) dot.style.background = ganConnected ? '#4adb8a' : 'var(--muted)';
    updateDeviceButtonLabel?.();
    updateDisconnectBtn?.();
  }, 1000);
});
