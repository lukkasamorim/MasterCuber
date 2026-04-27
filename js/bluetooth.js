// ═══════════════════════════════════════════════
//  SMART CUBE BLUETOOTH — QiYi Tornado V3
//  UUIDs confirmados via DevTools
// ═══════════════════════════════════════════════

let cubeDevice      = null;
let cubeChar        = null;
let cubeConnected   = false;
let cubeMoveHistory = [];
let cubeLastBytes   = null;

// UUIDs confirmados do QY-QYSC-S-E580
const CUBE_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const CUBE_CHARS   = [
  '0000fff5-0000-1000-8000-00805f9b34fb',  // provavelmente notify
  '0000fff6-0000-1000-8000-00805f9b34fb',
  '0000fff7-0000-1000-8000-00805f9b34fb',
  '0000fff4-0000-1000-8000-00805f9b34fb',
];

// Mapa de movimentos QiYi
const MOVE_MAP = {
  0:  'U',  1:  "U'",
  2:  'U2', 3:  'D',
  4:  "D'", 5:  'D2',
  6:  'R',  7:  "R'",
  8:  'R2', 9:  'L',
  10: "L'", 11: 'L2',
  12: 'F',  13: "F'",
  14: 'F2', 15: 'B',
  16: "B'", 17: 'B2',
};

// ── UI ──────────────────────────────────────
function setCubeStatus(text, color) {
  const btn = document.getElementById('btn-cube-connect');
  const dot = document.getElementById('cube-bt-dot');
  if (btn) btn.textContent = text;
  if (dot) dot.style.background = color || 'var(--muted)';
}

function updateMoveDisplay(move) {
  const el = document.getElementById('cube-move-display');
  if (!el) return;
  el.textContent = move;
  el.style.opacity = '1';
  el.style.color   = 'var(--accent)';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0.3'; }, 500);
}

function updateMoveHistory() {
  const el = document.getElementById('cube-move-history');
  if (el) el.textContent = cubeMoveHistory.slice(-10).join(' ');
}

// ── Parser de pacotes ────────────────────────
function parsePacket(data) {
  const b = new Uint8Array(data.buffer);
  console.log('[BT] Pacote:', Array.from(b).map(x => x.toString(16).padStart(2,'0')).join(' '));

  // Protocolo QiYi: cada byte de movimento está em posições específicas
  // Tenta detectar movimento pelo padrão do pacote
  if (b.length >= 2) {
    // Tenta byte 0 como tipo e byte 1 como movimento
    let moveCode = null;

    if (b[0] === 0xfe || b[0] === 0x02) {
      moveCode = b[1];
    } else if (b.length >= 6) {
      // Pacote de estado — pega últimos bytes
      moveCode = b[b.length - 2];
    } else {
      moveCode = b[0];
    }

    const move = MOVE_MAP[moveCode];
    if (move) {
      cubeMoveHistory.push(move);
      if (cubeMoveHistory.length > 50) cubeMoveHistory.shift();
      updateMoveDisplay(move);
      updateMoveHistory();

      // Timer automático
      if (timerState === STATE.INSPECTION) {
        startRunning();
      } else if (timerState === STATE.IDLE) {
        if (cfg?.inspection !== false) {
          startInspection();
        } else {
          startRunning();
        }
      }
    }

    // Verifica estado resolvido (54 bytes = estado completo)
    if (b.length >= 54 && timerState === STATE.RUNNING) {
      const faces = Array.from(b.slice(0, 54));
      if (isSolved(faces)) onCubeSolved();
    }
  }
}

function isSolved(state) {
  for (let f = 0; f < 6; f++) {
    const base = state[f * 9];
    for (let i = 1; i < 9; i++) {
      if (state[f * 9 + i] !== base) return false;
    }
  }
  return true;
}

function onCubeSolved() {
  cancelAnimationFrame(rafId);
  const t = Date.now() - startTime;
  setTimerState(STATE.IDLE);
  setHint('idle');
  elTimer.textContent = fmtTime(t);
  setFocusMode(false);
  saveTime(t);
  showToast('🎉 Cubo resolvido! ' + fmtTime(t));
  cubeMoveHistory = [];
  updateMoveHistory();
}

// ── Conexão ──────────────────────────────────
async function connectSmartCube() {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth não suportado. Use Chrome ou Edge.');
    return;
  }
  if (cubeConnected) { disconnectSmartCube(); return; }

  try {
    setCubeStatus('🔵 Conectando...', '#7dd3fc');

    cubeDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [CUBE_SERVICE],
    });

    cubeDevice.addEventListener('gattserverdisconnected', onCubeDisconnected);

    const server  = await cubeDevice.gatt.connect();
    const service = await server.getPrimaryService(CUBE_SERVICE);
    const chars   = await service.getCharacteristics();

    console.log('[BT] Characteristics disponíveis:');
    chars.forEach(c => {
      const props = Object.keys(c.properties).filter(k => c.properties[k]);
      console.log(' ', c.uuid, props);
    });

    // Tenta cada characteristic para encontrar a que faz notify
    let notifyChar = null;
    for (const uuid of CUBE_CHARS) {
      try {
        const ch = await service.getCharacteristic(uuid);
        if (ch.properties.notify || ch.properties.indicate) {
          notifyChar = ch;
          console.log('[BT] Usando characteristic:', uuid);
          break;
        }
      } catch(e) {}
    }

    // Fallback: usa qualquer char com notify
    if (!notifyChar) {
      notifyChar = chars.find(c => c.properties.notify || c.properties.indicate);
    }

    if (!notifyChar) {
      // Tenta read em todas para ver qual responde
      showToast('⚠️ Cubo conectado mas sem notify. Tentando read...');
      notifyChar = chars[0];
    }

    cubeChar = notifyChar;

    try {
      await cubeChar.startNotifications();
      cubeChar.addEventListener('characteristicvaluechanged', e => parsePacket(e.target.value));
      console.log('[BT] Notificações ativas!');
    } catch(e) {
      console.warn('[BT] startNotifications falhou, tentando read:', e);
      // Fallback: polling via read
      startCubePolling(service, chars);
    }

    cubeConnected = true;
    const name = cubeDevice.name || 'Cubo';
    setCubeStatus('🟢 ' + name, '#4adb8a');
    showToast('✅ ' + name + ' conectado! Mova uma peça.');

    const panel = document.getElementById('cube-panel');
    if (panel) panel.style.display = 'flex';

  } catch(err) {
    cubeConnected = false;
    console.error('[BT] Erro:', err);
    if (err.name !== 'NotFoundError') {
      setCubeStatus('❌ Erro', '#e8584a');
      showToast('Erro: ' + err.message);
      setTimeout(() => setCubeStatus('🔵 Conectar Cubo', null), 4000);
    } else {
      setCubeStatus('🔵 Conectar Cubo', null);
    }
  }
}

// Polling como fallback se notify não funcionar
let _pollInterval = null;
async function startCubePolling(service, chars) {
  console.log('[BT] Iniciando polling...');
  _pollInterval = setInterval(async () => {
    for (const ch of chars) {
      try {
        const val = await ch.readValue();
        const bytes = new Uint8Array(val.buffer);
        const hex = Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');
        if (hex !== cubeLastBytes) {
          cubeLastBytes = hex;
          parsePacket(val);
        }
      } catch(e) {}
    }
  }, 100);
}

function disconnectSmartCube() {
  clearInterval(_pollInterval);
  if (cubeDevice?.gatt?.connected) cubeDevice.gatt.disconnect();
  onCubeDisconnected();
}

function onCubeDisconnected() {
  clearInterval(_pollInterval);
  cubeConnected = false;
  cubeChar = null;
  setCubeStatus('🔵 Conectar Cubo', null);
  showToast('Cubo desconectado.');
  const panel = document.getElementById('cube-panel');
  if (panel) panel.style.display = 'none';
  cubeMoveHistory = [];
}
