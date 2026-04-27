// ═══════════════════════════════════════════════
//  SMART CUBE BLUETOOTH — QiYi Tornado V3
//  Protocolo com AES128-ECB + App Hello
//  Ref: github.com/Flying-Toast/qiyi_smartcube_protocol
// ═══════════════════════════════════════════════

let cubeDevice      = null;
let cubeChar        = null;
let cubeConnected   = false;
let cubeMoveHistory = [];
let cubeMacAddress  = null;

// UUID do serviço e characteristic principal
const CUBE_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const CUBE_CHAR    = '0000fff6-0000-1000-8000-00805f9b34fb';

// Chave AES fixa do protocolo QiYi
const AES_KEY = [87,177,249,171,205,90,232,167,156,185,140,231,87,140,81,8];

// Mapa de movimentos (índice → notação)
const MOVE_NAMES = ['U',"U'",'U2','D',"D'",'D2','R',"R'",'R2','L',"L'",'L2','F',"F'",'F2','B',"B'",'B2'];

// ── AES-128 ECB (implementação mínima) ───────
// Tabela S-box AES
const SBOX=[99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];

function subBytes(s){return s.map(b=>SBOX[b]);}
function rotWord(w){return[w[1],w[2],w[3],w[0]];}
function xorWords(a,b){return a.map((v,i)=>v^b[i]);}

function keyExpansion(key){
  const rcon=[0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
  let w=[];
  for(let i=0;i<4;i++) w.push(key.slice(i*4,i*4+4));
  for(let i=4;i<44;i++){
    let t=[...w[i-1]];
    if(i%4===0) t=xorWords(subBytes(rotWord(t)),[rcon[i/4-1],0,0,0]);
    w.push(xorWords(w[i-4],t));
  }
  return w;
}

function aesEncryptBlock(block, keyWords){
  const N=4;
  let state=[];
  for(let c=0;c<4;c++) state.push([block[c*4],block[c*4+1],block[c*4+2],block[c*4+3]]);
  
  // addRoundKey
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[c][r];
  
  const mul2=b=>b&0x80?(b<<1)^0x1b:(b<<1)&0xff;
  const mul=function(a,b){let r=0,t=a;for(let i=0;i<8;i++){if(b&1)r^=t;t=mul2(t);b>>=1;}return r&0xff;};
  
  for(let round=1;round<=10;round++){
    // subBytes
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]=SBOX[state[c][r]];
    // shiftRows
    for(let r=1;r<4;r++){let t=[];for(let c=0;c<4;c++)t.push(state[c][r]);for(let c=0;c<4;c++)state[c][r]=t[(c+r)%4];}
    // mixColumns (skip last round)
    if(round<10){
      for(let c=0;c<4;c++){
        const s=state[c];
        state[c]=[mul(s[0],2)^mul(s[1],3)^s[2]^s[3],s[0]^mul(s[1],2)^mul(s[2],3)^s[3],s[0]^s[1]^mul(s[2],2)^mul(s[3],3),mul(s[0],3)^s[1]^s[2]^mul(s[3],2)];
      }
    }
    // addRoundKey
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[round*4+c][r];
  }
  
  let out=[];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) out.push(state[c][r]);
  return out;
}

// Descriptografar bloco AES (ECB)
const RSBOX=[82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37,114,248,246,100,134,104,152,22,212,164,92,204,93,101,182,146,108,112,72,80,253,237,185,218,94,21,70,87,167,141,157,132,144,216,171,0,140,188,211,10,247,228,88,5,184,179,69,6,208,44,30,143,202,63,15,2,193,175,189,3,1,19,138,107,58,145,17,65,79,103,220,234,151,242,207,206,240,180,230,115,150,172,116,34,231,173,53,133,226,249,55,232,28,117,223,110,71,241,26,113,29,41,197,137,111,183,98,14,170,24,190,27,252,86,62,75,198,210,121,32,154,219,192,254,120,205,90,244,31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];

function aesDecryptBlock(block, keyWords){
  const N=4;
  let state=[];
  for(let c=0;c<4;c++) state.push([block[c*4],block[c*4+1],block[c*4+2],block[c*4+3]]);
  
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[40+c][r];
  
  const mul2=b=>b&0x80?(b<<1)^0x1b:(b<<1)&0xff;
  const mul=function(a,b){let r=0,t=a;for(let i=0;i<8;i++){if(b&1)r^=t;t=mul2(t);b>>=1;}return r&0xff;};
  
  for(let round=9;round>=0;round--){
    // invShiftRows
    for(let r=1;r<4;r++){let t=[];for(let c=0;c<4;c++)t.push(state[c][r]);for(let c=0;c<4;c++)state[c][r]=t[(c+4-r)%4];}
    // invSubBytes
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]=RSBOX[state[c][r]];
    // addRoundKey
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[round*4+c][r];
    // invMixColumns (skip round 0)
    if(round>0){
      for(let c=0;c<4;c++){
        const s=state[c];
        state[c]=[mul(s[0],14)^mul(s[1],11)^mul(s[2],13)^mul(s[3],9),mul(s[0],9)^mul(s[1],14)^mul(s[2],11)^mul(s[3],13),mul(s[0],13)^mul(s[1],9)^mul(s[2],14)^mul(s[3],11),mul(s[0],11)^mul(s[1],13)^mul(s[2],9)^mul(s[3],14)];
      }
    }
  }
  
  let out=[];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) out.push(state[c][r]);
  return out;
}

let _keyWords = null;
function getKeyWords(){ if(!_keyWords) _keyWords=keyExpansion(AES_KEY); return _keyWords; }

function aesEncrypt(data){
  const kw=getKeyWords();
  // Pad to multiple of 16
  const padded=[...data];
  while(padded.length%16!==0) padded.push(0);
  let out=[];
  for(let i=0;i<padded.length;i+=16) out=[...out,...aesEncryptBlock(padded.slice(i,i+16),kw)];
  return out;
}

function aesDecrypt(data){
  const kw=getKeyWords();
  let out=[];
  for(let i=0;i<data.length;i+=16) out=[...out,...aesDecryptBlock(data.slice(i,i+16),kw)];
  return out;
}

// ── Checksum ─────────────────────────────────
function calcChecksum(msg){
  return msg.reduce((a,b)=>a+b,0)&0xff;
}

// ── Monta e envia mensagem ────────────────────
async function sendMsg(payload){
  if(!cubeChar) return;
  // Pad com zeros até múltiplo de 16
  const padded=[...payload];
  while(padded.length%16!==0) padded.push(0);
  const encrypted=aesEncrypt(padded);
  await cubeChar.writeValue(new Uint8Array(encrypted));
}

// ── App Hello ────────────────────────────────
// Formato: fe 15 00 [mac_reversed 6 bytes] [zeros] [checksum]
async function sendAppHello(macBytes){
  // macBytes = [b0,b1,b2,b3,b4,b5] — invertemos
  const mac = [...macBytes].reverse();
  const msg = [0xfe,0x15,0x00,0x6b,0x01,0x00,0x00,0x22,0x06,0x00,0x02,0x08,0x00,
               mac[0],mac[1],mac[2],mac[3],mac[4],mac[5],0x00,0x00];
  // Checksum = soma de todos os bytes
  msg.push(calcChecksum(msg));
  console.log('[BT] App Hello:', msg.map(x=>x.toString(16).padStart(2,'0')).join(' '));
  await sendMsg(msg);
}

// ── ACK ──────────────────────────────────────
async function sendAck(msgBytes){
  const h = msgBytes.slice(3,8);
  const ack = [0xfe,0x09,...h];
  ack.push(calcChecksum(ack));
  await sendMsg(ack);
}

// ── Recebe pacote ─────────────────────────────
function onCubeData(event){
  const raw = new Uint8Array(event.target.value.buffer);
  const dec = aesDecrypt(Array.from(raw));
  console.log('[BT] Dec:', dec.map(x=>x.toString(16).padStart(2,'0')).join(' '));

  const type = dec[1]; // byte 1 = tipo da mensagem

  if(type === 0xa1){
    // Cube Hello — cubo respondeu ao App Hello!
    console.log('[BT] Cube Hello recebido — cubo pronto!');
    showToast('🟢 Cubo pronto! Mova uma peça.');
    sendAck(dec);
    // Pede estado atual
    sendMsg([0xfe,0x11,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
  }

  if(type === 0xa2){
    // Movimento
    const move = MOVE_NAMES[dec[3]];
    if(move){
      cubeMoveHistory.push(move);
      if(cubeMoveHistory.length>50) cubeMoveHistory.shift();
      updateMoveDisplay(move);
      updateMoveHistory();
      sendAck(dec);

      if(timerState === STATE.INSPECTION) startRunning();
      else if(timerState === STATE.IDLE){
        if(cfg?.inspection !== false) startInspection();
        else startRunning();
      }
    }
  }

  if(type === 0xa5){
    // Estado completo do cubo
    const state = dec.slice(3, 57);
    if(timerState === STATE.RUNNING && isCubeSolved(state)){
      onCubeSolved();
    }
    sendAck(dec);
  }
}

function isCubeSolved(state){
  for(let f=0;f<6;f++){
    const base=state[f*9];
    for(let i=1;i<9;i++) if(state[f*9+i]!==base) return false;
  }
  return true;
}

function onCubeSolved(){
  cancelAnimationFrame(rafId);
  const t = Date.now() - startTime;
  setTimerState(STATE.IDLE);
  setHint('idle');
  elTimer.textContent = fmtTime(t);
  setFocusMode(false);
  saveTime(t);
  showToast('🎉 ' + fmtTime(t));
  cubeMoveHistory = [];
  updateMoveHistory();
}

// ── UI ───────────────────────────────────────
function setCubeStatus(text, color){
  const btn = document.getElementById('btn-cube-connect');
  const dot = document.getElementById('cube-bt-dot');
  if(btn) btn.textContent = text;
  if(dot) dot.style.background = color || 'var(--muted)';
}

function updateMoveDisplay(move){
  const el = document.getElementById('cube-move-display');
  if(!el) return;
  el.textContent = move;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0.3'; }, 500);
}

function updateMoveHistory(){
  const el = document.getElementById('cube-move-history');
  if(el) el.textContent = cubeMoveHistory.slice(-10).join(' ');
}

// ── Conexão ──────────────────────────────────
async function connectSmartCube(){
  if(!navigator.bluetooth){ showToast('Use Chrome ou Edge para conectar o cubo.'); return; }
  if(cubeConnected){ disconnectSmartCube(); return; }

  try {
    // Pede o MAC ao usuário (igual ao cstimer)
    let macInput = localStorage.getItem('ct_cube_mac') || '';
    macInput = prompt(
      'Digite o MAC address do seu cubo (ex: CC:A3:00:00:E5:80)\n\n' +
      'Você pode encontrar em: chrome://bluetooth-internals/#devices\n' +
      'Ou ative chrome://flags/#enable-experimental-web-platform-features',
      macInput
    );
    if(!macInput) return;

    // Valida e parseia o MAC
    const macStr = macInput.trim().toUpperCase().replace(/-/g,':');
    const macParts = macStr.split(':');
    if(macParts.length !== 6){
      showToast('MAC inválido. Use o formato CC:A3:00:00:E5:80');
      return;
    }
    const macBytes = macParts.map(x => parseInt(x,16));
    localStorage.setItem('ct_cube_mac', macStr);

    setCubeStatus('🔵 Conectando...','#7dd3fc');

    cubeDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [CUBE_SERVICE],
    });

    cubeDevice.addEventListener('gattserverdisconnected', onCubeDisconnected);

    const server  = await cubeDevice.gatt.connect();
    const service = await server.getPrimaryService(CUBE_SERVICE);
    cubeChar      = await service.getCharacteristic(CUBE_CHAR);

    await cubeChar.startNotifications();
    cubeChar.addEventListener('characteristicvaluechanged', onCubeData);

    // Envia App Hello com o MAC real
    await sendAppHello(macBytes);
    console.log('[BT] App Hello enviado com MAC:', macStr);

    cubeConnected = true;
    const name = cubeDevice.name || 'QiYi';
    setCubeStatus('🟢 ' + name, '#4adb8a');
    showToast('✅ ' + name + ' conectado!');

    const panel = document.getElementById('cube-panel');
    if(panel) panel.style.display = 'flex';

  } catch(err){
    cubeConnected = false;
    console.error('[BT]', err);
    if(err.name !== 'NotFoundError'){
      setCubeStatus('❌ Erro','#e8584a');
      showToast('Erro: ' + err.message);
      setTimeout(()=>setCubeStatus('🔵 Conectar Cubo',null), 4000);
    } else {
      setCubeStatus('🔵 Conectar Cubo', null);
    }
  }
}

function disconnectSmartCube(){
  if(cubeDevice?.gatt?.connected) cubeDevice.gatt.disconnect();
  onCubeDisconnected();
}

function onCubeDisconnected(){
  cubeConnected = false;
  cubeChar = null;
  setCubeStatus('🔵 Conectar Cubo', null);
  showToast('Cubo desconectado.');
  const panel = document.getElementById('cube-panel');
  if(panel) panel.style.display = 'none';
  cubeMoveHistory = [];
}
