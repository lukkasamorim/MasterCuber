// ═══════════════════════════════════════════════
//  SMART CUBE BLUETOOTH — QiYi Tornado V3
//  Protocolo baseado no cstimer (parseQYData)
//  Ref: github.com/cs-bin/cstimer
// ═══════════════════════════════════════════════

let cubeDevice      = null;
let cubeChar        = null;
let cubeConnected   = false;
let cubeMoveHistory = [];
let cubeMacAddress  = null;

// UUID do serviço e characteristics
const CUBE_SERVICE   = '0000fff0-0000-1000-8000-00805f9b34fb';
const CUBE_CHAR_READ = '0000fff6-0000-1000-8000-00805f9b34fb'; // notificações
// Nota: fff6 é leitura E escrita no QiYi (mesma char)

// Chave AES do protocolo QiYi (119 repetido, igual ao cstimer)
const AES_KEY = Array(16).fill(119);

// Mapa de movimentos — índice → notação
// No QiYi: byte de movimento é (face*2 + dir), faces = [F,B,U,D,L,R]
// cstimer usa: [4,1,3,0,2,5] como mapeamento de face para URFDLB
const QIYI_FACE_MAP = [4, 1, 3, 0, 2, 5]; // index do byte → índice URFDLB
const MOVE_NAMES = ['U',"U'",'U2','D',"D'",'D2','R',"R'",'R2','L',"L'",'L2','F',"F'",'F2','B',"B'",'B2'];

// Estado interno do cubo (para detectar cubo resolvido)
let cubeState = null;
let lastMoveSeq = -1;

// ── AES-128 ECB (implementação mínima) ───────
const SBOX=[99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22];
const RSBOX=[82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37,114,248,246,100,134,104,152,22,212,164,92,204,93,101,182,146,108,112,72,80,253,237,185,218,94,21,70,87,167,141,157,132,144,216,171,0,140,188,211,10,247,228,88,5,184,179,69,6,208,44,30,143,202,63,15,2,193,175,189,3,1,19,138,107,58,145,17,65,79,103,220,234,151,242,207,206,240,180,230,115,150,172,116,34,231,173,53,133,226,249,55,232,28,117,223,110,71,241,26,113,29,41,197,137,111,183,98,14,170,24,190,27,252,86,62,75,198,210,121,32,154,219,192,254,120,205,90,244,31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];

function rotWord(w){return[w[1],w[2],w[3],w[0]];}
function xorWords(a,b){return a.map((v,i)=>v^b[i]);}

function keyExpansion(key){
  const rcon=[0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
  let w=[];
  for(let i=0;i<4;i++) w.push(key.slice(i*4,i*4+4));
  for(let i=4;i<44;i++){
    let t=[...w[i-1]];
    if(i%4===0) t=xorWords(t.map(b=>SBOX[rotWord(t)[t.indexOf(b)]]),[rcon[i/4-1],0,0,0]);
    // correção: subBytes(rotWord(t))
    if(i%4===0){
      let rw=rotWord([...w[i-1]]);
      t=xorWords(rw.map(b=>SBOX[b]),[rcon[i/4-1],0,0,0]);
    }
    w.push(xorWords(w[i-4],t));
  }
  return w;
}

function aesEncryptBlock(block, keyWords){
  let state=[];
  for(let c=0;c<4;c++) state.push([block[c*4],block[c*4+1],block[c*4+2],block[c*4+3]]);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[c][r];
  const mul2=b=>b&0x80?(b<<1)^0x1b:(b<<1)&0xff;
  const mul=function(a,b){let r=0,t=a;for(let i=0;i<8;i++){if(b&1)r^=t;t=mul2(t);b>>=1;}return r&0xff;};
  for(let round=1;round<=10;round++){
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]=SBOX[state[c][r]];
    for(let r=1;r<4;r++){let t=[];for(let c=0;c<4;c++)t.push(state[c][r]);for(let c=0;c<4;c++)state[c][r]=t[(c+r)%4];}
    if(round<10){
      for(let c=0;c<4;c++){
        const s=state[c];
        state[c]=[mul(s[0],2)^mul(s[1],3)^s[2]^s[3],s[0]^mul(s[1],2)^mul(s[2],3)^s[3],s[0]^s[1]^mul(s[2],2)^mul(s[3],3),mul(s[0],3)^s[1]^s[2]^mul(s[3],2)];
      }
    }
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[round*4+c][r];
  }
  let out=[];
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) out.push(state[c][r]);
  return out;
}

function aesDecryptBlock(block, keyWords){
  let state=[];
  for(let c=0;c<4;c++) state.push([block[c*4],block[c*4+1],block[c*4+2],block[c*4+3]]);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[40+c][r];
  const mul2=b=>b&0x80?(b<<1)^0x1b:(b<<1)&0xff;
  const mul=function(a,b){let r=0,t=a;for(let i=0;i<8;i++){if(b&1)r^=t;t=mul2(t);b>>=1;}return r&0xff;};
  for(let round=9;round>=0;round--){
    for(let r=1;r<4;r++){let t=[];for(let c=0;c<4;c++)t.push(state[c][r]);for(let c=0;c<4;c++)state[c][r]=t[(c+4-r)%4];}
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]=RSBOX[state[c][r]];
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) state[c][r]^=keyWords[round*4+c][r];
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

// ── CRC16 (protocolo QiYi usa CRC16, não simples checksum) ──
function crc16(data){
  let crc = 0xFFFF;
  for(let i=0;i<data.length;i++){
    crc ^= data[i];
    for(let j=0;j<8;j++)
      crc = (crc&1) ? (crc>>1)^0xA001 : (crc>>1);
  }
  return crc;
}

// ── Monta e envia mensagem encriptada ─────────
// Formato do protocolo QiYi (baseado no cstimer parseQYData):
// [seq_hi, seq_lo, dest_hi, dest_lo, src_hi, src_lo, src_lo2, src_lo3,
//  type_hi, type_lo, len_hi, len_lo, ...payload, crc_hi, crc_lo]
// Tudo encriptado em blocos de 16 bytes com prefixo de tamanho
let sendSeq = 1;
async function sendQiyiMsg(type, payload){
  if(!cubeChar) return;
  
  const src = 0x00000021; // source id
  const dst = 0x00000000; // dest
  
  // Monta header + payload
  const msg = [];
  msg.push(sendSeq>>24&0xFF, sendSeq>>16&0xFF, sendSeq>>8&0xFF, sendSeq&0xFF); // seq (dest)
  msg.push(0, 0, 0, 0);                                                          // src
  msg.push(type>>8&0xFF, type&0xFF);                                              // type
  msg.push(payload.length>>8&0xFF, payload.length&0xFF);                         // len
  for(const b of payload) msg.push(b);
  
  const c = crc16(msg);
  msg.push(c>>8&0xFF, c&0xFF);
  
  sendSeq++;
  
  // Encripta em blocos de 16 com prefixo
  const encrypted = [];
  for(let i=0; i<msg.length; i+=16){
    const block = msg.slice(i, i+16);
    while(block.length < 16) block.push(1);
    aesEncryptBlock(block, getKeyWords()); // in-place nos mesmos bytes
    const enc = aesEncryptBlock(msg.slice(i, Math.min(i+16, msg.length+16-1)).map((_,j)=>msg[i+j]||1), getKeyWords());
    if(i===0) encrypted.push(0, msg.length+2, 64, 0);
    else encrypted.push(i>>4);
    for(const b of enc) encrypted.push(b);
  }
  
  console.log('[BT] Enviando tipo 0x'+type.toString(16)+':', msg.map(x=>x.toString(16).padStart(2,'0')).join(' '));
  await cubeChar.writeValue(new Uint8Array(encrypted));
}

// ── Handshake inicial ─────────────────────────
// Mensagem tipo 0x0001 = solicitar estado
// Mensagem tipo 0x0105 = app hello com MAC
async function sendAppHello(macBytes){
  // Payload: [0, 0, 0, 0, 0, 0x21, 8, 0, 1, 5, 90, mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]]
  const payload = [0, 0, 0, 0, 0, 0x21, 8, 0, 1, 5, 90];
  // MAC em ordem reversa (byte mais significativo primeiro)
  for(let i=5; i>=0; i--) payload.push(macBytes[i]);
  
  console.log('[BT] App Hello payload:', payload.map(x=>x.toString(16).padStart(2,'0')).join(' '));
  await sendQiyiMsg(0x0001, payload);
}

// ── Decodifica facelet do estado do cubo ──────
// cstimer: para 54 nibbles, [face_nibbles] → facelet string
function decodeFacelet(data){
  // data tem 27 bytes = 54 nibbles (cada nibble = uma face do cubo)
  const faces = [];
  for(let i=0; i<data.length; i++){
    faces.push(data[i]>>4&0xF);
    faces.push(data[i]&0xF);
  }
  // Converter para string URFDLB (valores 0-5)
  const faceStr = faces.slice(0,54).map(f=>'LRDUFB'.charAt(f)).join('');
  return faceStr;
}

// ── Recebe pacote ─────────────────────────────
let recvBuffer = [];
let recvExpected = 0;

function onCubeData(event){
  const raw = new Uint8Array(event.target.value.buffer);
  console.log('[BT] Raw recv:', Array.from(raw).map(x=>x.toString(16).padStart(2,'0')).join(' '));
  
  // Protocolo QiYi: primeiro byte indica posição do bloco
  // 0x00 = primeiro bloco, contém tamanho total no byte 1
  // Outros = continuação
  
  let bytes = Array.from(raw);
  
  if(bytes[0] === 0){
    // Primeiro bloco
    recvExpected = bytes[1] - 2; // tamanho total do payload decriptado
    recvBuffer = [];
  }
  
  // Decripta bloco de 16 bytes (bytes 1-16 ou 0-15 dependendo)
  const blockStart = (bytes[0] === 0) ? 4 : 1; // pular prefixo
  const block = bytes.slice(blockStart, blockStart+16);
  if(block.length === 16){
    const dec = aesDecryptBlock(block, getKeyWords());
    recvBuffer = recvBuffer.concat(dec);
  }
  
  // Verificar se temos dados suficientes
  if(recvBuffer.length < 12) return;
  
  processQiyiPacket(recvBuffer.slice(0, recvExpected || recvBuffer.length));
}

function processQiyiPacket(data){
  if(data.length < 12) return;
  
  const typeHi = data[8];
  const typeLo = data[9];
  const type = (typeHi<<8)|typeLo;
  const len = (data[10]<<8)|data[11];
  const payload = data.slice(12, 12+len);
  
  console.log('[BT] Packet type:', '0x'+type.toString(16), 'len:', len, 'payload:', payload.slice(0,Math.min(10,payload.length)).map(x=>x.toString(16).padStart(2,'0')).join(' '));
  
  // Verificar CRC
  const bodyForCrc = data.slice(0, 12+len);
  // os últimos 2 bytes após len bytes são o CRC
  
  if(type === 0x1003){
    // Mensagem de evento (move ou estado)
    handleQiyiEvent(payload);
  } else if(type === 0x0002 || type === 0x0102){
    // Resposta ao hello / estado inicial
    console.log('[BT] Handshake OK, solicitando estado...');
    requestCubeState();
  } else if(type === 0x0003){
    // Estado completo do cubo
    handleCubeState(payload);
  } else {
    console.log('[BT] Pacote desconhecido tipo:', '0x'+type.toString(16));
  }
  
  recvBuffer = [];
}

function handleQiyiEvent(payload){
  if(payload.length < 1) return;
  
  const subtype = payload[0];
  const subtype2 = payload.length > 1 ? payload[1] : 0;
  
  console.log('[BT] Event subtype:', subtype, subtype2);
  
  if(subtype === 1 && subtype2 === 1){
    // Movimento!
    if(payload.length < 12) return;
    
    const solveTime = (payload[8]<<24)|(payload[9]<<16)|(payload[10]<<8)|payload[11];
    const inspectTime = payload.length >= 16 ? (payload[12]<<24)|(payload[13]<<16)|(payload[14]<<8)|payload[15] : 0;
    
    console.log('[BT] Solve stop! time:', solveTime);
    
    // ACK
    sendQiyiMsg(0x1003, [0]);
    
    if(timerState === STATE.RUNNING){
      // Cubo parado (solve completo detectado pelo cubo)
      onCubeSolved();
    }
    
  } else if(subtype === 4 && subtype2 === 4){
    // Status update (inclui movimento)
    if(payload.length < 5) return;
    
    const status = [0,1,2,3,4,5,6] // estados
    const cubeStatus = payload[4];
    const moveRaw = payload.length > 5 ? payload[5] : 0;
    const solveTimeRaw = payload.length > 9 ? (payload[5]<<24)|(payload[6]<<16)|(payload[7]<<8)|payload[8] : 0;
    
    // Move: byte = face*2 + direction
    // face map: [2,5,0,3,4,1] → FBUDLR → precisa converter pra URFDLB
    if(payload.length > 9){
      // tem informação de movimento
      const faceRaw = moveRaw>>1;
      const dir = moveRaw&1;
      
      // Mapeamento de face QiYi → URFDLB
      // QiYi usa FBUDLR internamente
      const qiyiToUrfdlb = [2, 4, 0, 3, 5, 1]; // F→F(2), B→B(5), U→U(0), D→D(3), L→L(4), R→R(1) em URFDLB
      
      if(faceRaw < 6){
        const faceUrfdlb = qiyiToUrfdlb[faceRaw];
        const moveIdx = faceUrfdlb*3 + (dir ? 2 : 0); // 0=normal, 2=prime
        const moveName = MOVE_NAMES[moveIdx];
        
        if(moveName){
          console.log('[BT] Move:', moveName, '(raw face:', faceRaw, 'dir:', dir, ')');
          cubeMoveHistory.push(moveName);
          if(cubeMoveHistory.length>50) cubeMoveHistory.shift();
          updateMoveDisplay(moveName);
          updateMoveHistory();
          
          // Iniciar timer se necessário
          if(typeof timerState !== 'undefined'){
            if(timerState === STATE.INSPECTION) startRunning();
            else if(timerState === STATE.IDLE){
              if(cfg?.inspection !== false) startInspection();
              else startRunning();
            }
          }
        }
      }
    }
    
    // Solicitar estado atualizado para verificar se está resolvido
    if(typeof timerState !== 'undefined' && timerState === STATE.RUNNING){
      requestCubeState();
    }
    
    sendQiyiMsg(0x1003, [0]);
  }
}

function handleCubeState(payload){
  if(payload.length < 27) return;
  
  const facelet = decodeFacelet(payload.slice(0, 27));
  console.log('[BT] Estado do cubo:', facelet);
  
  cubeState = facelet;
  
  if(typeof timerState !== 'undefined' && timerState === STATE.RUNNING){
    if(isCubeSolvedFacelet(facelet)){
      onCubeSolved();
    }
  }
}

function isCubeSolvedFacelet(facelet){
  // Verifica se todas as 6 faces têm cor uniforme
  const solved = 'UUUUUUUUURRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
  // Não pode comparar diretamente (orientação pode diferir)
  // Verificar se cada grupo de 9 tem a mesma cor
  for(let f=0; f<6; f++){
    const base = facelet[f*9];
    for(let i=1; i<9; i++){
      if(facelet[f*9+i] !== base) return false;
    }
  }
  return true;
}

async function requestCubeState(){
  // Tipo 0x0003 = solicitar estado do cubo
  await sendQiyiMsg(0x0003, []);
}

// ── Cubo resolvido ────────────────────────────
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
    // Pede o MAC ao usuário
    let macInput = localStorage.getItem('ct_cube_mac') || '';
    macInput = prompt(
      'Digite o MAC address do seu cubo (ex: CC:A3:00:00:E5:80)\n\n' +
      'Você pode encontrar em: chrome://bluetooth-internals/#devices',
      macInput
    );
    if(!macInput) return;

    const macStr = macInput.trim().toUpperCase().replace(/-/g,':');
    const macParts = macStr.split(':');
    if(macParts.length !== 6){
      showToast('MAC inválido. Use o formato CC:A3:00:00:E5:80');
      return;
    }
    const macBytes = macParts.map(x => parseInt(x,16));
    localStorage.setItem('ct_cube_mac', macStr);

    // Resetar AES key com chave padrão QiYi (119 * 16)
    _keyWords = null;

    setCubeStatus('🔵 Conectando...','#7dd3fc');

    cubeDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'QY-' }],
      optionalServices: [CUBE_SERVICE],
    });

    cubeDevice.addEventListener('gattserverdisconnected', onCubeDisconnected);

    const server  = await cubeDevice.gatt.connect();
    const service = await server.getPrimaryService(CUBE_SERVICE);
    
    // Obter characteristic de leitura/escrita
    cubeChar = await service.getCharacteristic(CUBE_CHAR_READ);

    await cubeChar.startNotifications();
    cubeChar.addEventListener('characteristicvaluechanged', onCubeData);

    // Aguardar um momento e enviar App Hello
    await new Promise(r => setTimeout(r, 500));
    await sendAppHello(macBytes);
    console.log('[BT] App Hello enviado para MAC:', macStr);

    // Aguardar resposta e solicitar estado
    await new Promise(r => setTimeout(r, 1000));
    await requestCubeState();

    cubeConnected = true;
    const name = cubeDevice.name || 'QiYi';
    setCubeStatus('🟢 ' + name, '#4adb8a');
    showToast('✅ ' + name + ' conectado!');

    const panel = document.getElementById('cube-panel');
    if(panel) panel.style.display = 'flex';

    sendSeq = 1;
    recvBuffer = [];
    recvExpected = 0;

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
  recvBuffer = [];
  recvExpected = 0;
}
