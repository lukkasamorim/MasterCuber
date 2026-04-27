// ═══════════════════════════════════════════════
//  SMART CUBE BLUETOOTH — QiYi Tornado V3
//  Web Bluetooth API + protocolo QiYi/GAN
// ═══════════════════════════════════════════════

// Estado da conexão
let cubeDevice      = null;
let cubeChar        = null;
let cubeConnected   = false;
let cubeMoveHistory = [];   // movimentos em tempo real
let cubeState       = null; // estado atual das faces

// ── Cores das faces (estado resolvido) ──
// U=branco, D=amarelo, F=verde, B=azul, R=vermelho, L=laranja
const SOLVED_STATE = [
  0,0,0,0,0,0,0,0,0,  // U (branco=0)
  1,1,1,1,1,1,1,1,1,  // R (vermelho=1)
  2,2,2,2,2,2,2,2,2,  // F (verde=2)
  3,3,3,3,3,3,3,3,3,  // D (amarelo=3)
  4,4,4,4,4,4,4,4,4,  // L (laranja=4)
  5,5,5,5,5,5,5,5,5,  // B (azul=5)
];

// UUIDs do QiYi Tornado V3 (QY-QYSC)
const QIYI_SERVICE_UUID  = '0000aadb-0000-1000-8000-00805f9b34fb';
const QIYI_CHAR_UUID     = '0000aadc-0000-1000-8000-00805f9b34fb';

// UUIDs alternativos para tentar em fallback
const QIYI_SERVICE_ALT   = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const QIYI_CHAR_ALT_TX   = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Mapa de bytes → movimentos legíveis
const MOVE_MAP = {
  0x00: "B",  0x01: "B'",
  0x02: "F",  0x03: "F'",
  0x04: "U",  0x05: "U'",
  0x06: "D",  0x07: "D'",
  0x08: "L",  0x09: "L'",
  0x0A: "R",  0x0B: "R'",
};

// ── UI helpers ──────────────────────────────
function setCubeStatus(status, color) {
  const btn = document.getElementById('btn-cube-connect');
  const dot = document.getElementById('cube-bt-dot');
  if (!btn) return;
  btn.textContent = status;
  if (dot) dot.style.background = color || 'var(--muted)';
}

function updateMoveDisplay(move) {
  const el = document.getElementById('cube-move-display');
  if (!el) return;
  el.textContent = move;
  el.style.opacity = '1';
  setTimeout(() => { if (el) el.style.opacity = '0.3'; }, 400);
}

function updateMoveHistory() {
  const el = document.getElementById('cube-move-history');
  if (!el) return;
  el.textContent = cubeMoveHistory.slice(-8).join(' ');
}

// ── Verificação de cubo resolvido ────────────
function isSolved(state) {
  if (!state || state.length !== 54) return false;
  for (let face = 0; face < 6; face++) {
    const base = state[face * 9];
    for (let i = 1; i < 9; i++) {
      if (state[face * 9 + i] !== base) return false;
    }
  }
  return true;
}

// ── Parser de pacote QiYi ────────────────────
function parseQiYiPacket(data) {
  const bytes = new Uint8Array(data.buffer);

  // Tipo do pacote: 0x02 = movimento, 0x04 = estado completo
  const type = bytes[0];

  if (type === 0x02) {
    // Pacote de movimento
    const moveCode = bytes[1];
    const move = MOVE_MAP[moveCode];
    if (move) {
      cubeMoveHistory.push(move);
      if (cubeMoveHistory.length > 50) cubeMoveHistory.shift();
      updateMoveDisplay(move);
      updateMoveHistory();

      // Se timer está em inspeção e cubo foi mexido → inicia timer
      if (timerState === STATE.INSPECTION) {
        startRunning();
      }
      // Se timer está idle e cubo foi mexido → inicia inspeção ou timer direto
      if (timerState === STATE.IDLE) {
        if (cfg?.inspection !== false) {
          startInspection();
        } else {
          startRunning();
        }
      }
    }
  }

  if (type === 0x04) {
    // Pacote de estado completo das faces
    if (bytes.length >= 55) {
      cubeState = Array.from(bytes.slice(1, 55));

      // Verifica se resolveu
      if (timerState === STATE.RUNNING && isSolved(cubeState)) {
        onCubeSolved();
      }
    }
  }
}

// ── Cubo resolvido! ──────────────────────────
function onCubeSolved() {
  cancelAnimationFrame(rafId);
  const t = Date.now() - startTime;
  setTimerState(STATE.IDLE);
  setHint('idle');
  elTimer.textContent = fmtTime(t);
  setFocusMode(false);
  saveTime(t);

  // Feedback visual e sonoro
  playRankUpSound && playRankUpSound(false);
  showToast('🎉 Cubo resolvido! ' + fmtTime(t));

  // Limpa histórico de movimentos
  cubeMoveHistory = [];
  updateMoveHistory();
}

// ── Conexão Bluetooth ────────────────────────
async function connectSmartCube() {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth não suportado. Use Chrome ou Edge.');
    return;
  }

  if (cubeConnected) {
    disconnectSmartCube();
    return;
  }

  try {
    setCubeStatus('🔵 Conectando...', '#7dd3fc');

    cubeDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        QIYI_SERVICE_UUID,
        QIYI_SERVICE_ALT,
        '0000fff0-0000-1000-8000-00805f9b34fb',
        '0000ffe0-0000-1000-8000-00805f9b34fb',
      ],
    });

    cubeDevice.addEventListener('gattserverdisconnected', onCubeDisconnected);

    setCubeStatus('🔵 Conectando GATT...', '#7dd3fc');
    const server = await cubeDevice.gatt.connect();

    // Descobre todos os serviços disponíveis
    let services = [];
    try { services = await server.getPrimaryServices(); } catch(e) {}

    // Log para debug — aparece no console do browser
    console.log('[CubeTimer BT] Serviços encontrados:', services.map(s => s.uuid));

    // Tenta cada UUID de serviço conhecido
    let service = null;
    const serviceUUIDs = [QIYI_SERVICE_UUID, QIYI_SERVICE_ALT, '0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb'];

    for (const uuid of serviceUUIDs) {
      try {
        service = await server.getPrimaryService(uuid);
        console.log('[CubeTimer BT] Serviço encontrado:', uuid);
        break;
      } catch(e) { /* tenta próximo */ }
    }

    if (!service) {
      // Usa o primeiro serviço disponível como fallback
      if (services.length > 0) {
        service = services[0];
        console.log('[CubeTimer BT] Usando primeiro serviço:', service.uuid);
      } else {
        throw new Error('Nenhum serviço GATT encontrado no cubo.');
      }
    }

    // Descobre todas as characteristics do serviço
    let chars = [];
    try { chars = await service.getCharacteristics(); } catch(e) {}
    console.log('[CubeTimer BT] Características:', chars.map(c => c.uuid + ' props:' + JSON.stringify(c.properties)));

    // Tenta cada characteristic com notify
    const charUUIDs = [QIYI_CHAR_UUID, QIYI_CHAR_ALT_TX, ...chars.filter(c => c.properties.notify).map(c => c.uuid)];

    for (const uuid of [...new Set(charUUIDs)]) {
      try {
        cubeChar = await service.getCharacteristic(uuid);
        if (cubeChar.properties.notify) {
          await cubeChar.startNotifications();
          cubeChar.addEventListener('characteristicvaluechanged', (e) => {
            parseQiYiPacket(e.target.value);
          });
          console.log('[CubeTimer BT] Escutando characteristic:', uuid);
          break;
        }
      } catch(e) { cubeChar = null; }
    }

    if (!cubeChar) throw new Error('Nenhuma characteristic de notificação encontrada.');

    cubeConnected = true;
    setCubeStatus('🟢 ' + (cubeDevice.name || 'Cubo'), '#4adb8a');
    showToast('✅ Smart cube conectado! Mova uma peça para testar.');

    const panel = document.getElementById('cube-panel');
    if (panel) panel.style.display = 'flex';

  } catch (err) {
    cubeConnected = false;
    console.error('[CubeTimer BT] Erro:', err);
    if (err.name === 'NotFoundError') {
      setCubeStatus('🔵 Conectar Cubo', null);
    } else {
      setCubeStatus('❌ Erro', '#e8584a');
      showToast('Erro BT: ' + err.message);
      setTimeout(() => setCubeStatus('🔵 Conectar Cubo', null), 4000);
    }
  }
}

function disconnectSmartCube() {
  if (cubeDevice && cubeDevice.gatt.connected) {
    cubeDevice.gatt.disconnect();
  }
  onCubeDisconnected();
}

function onCubeDisconnected() {
  cubeConnected = false;
  cubeChar      = null;
  setCubeStatus('🔵 Conectar Cubo', null);
  showToast('Cubo desconectado.');
  const panel = document.getElementById('cube-panel');
  if (panel) panel.style.display = 'none';
  cubeMoveHistory = [];
}
