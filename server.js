const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];
  const filePath = urlPath === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, urlPath);
  // security: prevent path traversal
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = {};

const SHIP_DEFS = [
  { id:'s3',  size:3 },
  { id:'s2a', size:2 },
  { id:'s2b', size:2 },
  { id:'s1',  size:1 },
];
const COLS = ['A','B','C','D','E'];

function getNeighbors(cellKeys) {
  const nb = new Set();
  cellKeys.forEach(k => {
    const c=k[0], r=parseInt(k[1]), ci=COLS.indexOf(c);
    for (let dc=-1;dc<=1;dc++) for (let dr=-1;dr<=1;dr++) {
      if (!dc&&!dr) continue;
      const nc=COLS[ci+dc], nr=r+dr;
      if (nc&&nr>=1&&nr<=5) nb.add(nc+nr);
    }
  });
  return nb;
}

function canPlace(grid, size, dir, col, row) {
  const ci=COLS.indexOf(col), r=parseInt(row);
  const occ={};
  for (let i=0;i<size;i++) {
    let key;
    if (dir==='H'){const nc=COLS[ci+i];if(!nc)return null;key=nc+r;}
    else{const nr=r+i;if(nr>5)return null;key=col+nr;}
    occ[key]=true;
  }
  const nb=getNeighbors(Object.keys(grid));
  for (const k of Object.keys(occ)) { if(grid[k]||nb.has(k)) return null; }
  return occ;
}

function createState() {
  return { phase:'setup', grids:[{},{}], attacks:[{},{}], sunk:[[],[]], setupDone:[false,false], currentTurn:0, logs:[] };
}

function bcast(room, msg) {
  room.players.forEach((ws,i)=>{ if(ws&&ws.readyState===1) ws.send(JSON.stringify({...msg,myIndex:i})); });
}
function sendTo(ws, idx, msg) {
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({...msg,myIndex:idx}));
}
function sendState(room) {
  const s=room.state;
  room.players.forEach((ws,i)=>{
    if(!ws||ws.readyState!==1) return;
    const opp=1-i;
    const hidden={};
    Object.keys(s.grids[opp]).forEach(k=>{ if(s.sunk[i].includes(s.grids[opp][k])) hidden[k]=s.grids[opp][k]; });
    ws.send(JSON.stringify({
      type:'state', myIndex:i, phase:s.phase, currentTurn:s.currentTurn,
      myGrid:s.grids[i], oppAttackOnMe:s.attacks[opp], myAttackOnOpp:s.attacks[i],
      oppGrid:hidden, setupDone:s.setupDone, sunkByMe:s.sunk[i], sunkOnMe:s.sunk[opp], logs:s.logs.slice(0,20),
    }));
  });
}

wss.on('connection', (ws) => {
  let myRoom=null, myIndex=-1;

  ws.on('message', (raw) => {
    let msg; try{ msg=JSON.parse(raw); }catch{ return; }

    if (msg.type==='join') {
      const reqId=(msg.roomId||'').trim().toUpperCase();
      let roomId=null;
      if (reqId) {
        const r=rooms[reqId];
        if (!r) { sendTo(ws,-1,{type:'joinErr',message:'房間不存在，請確認房間碼'}); return; }
        if (r.players.filter(Boolean).length>=2) { sendTo(ws,-1,{type:'joinErr',message:'房間已滿'}); return; }
        roomId=reqId;
      } else {
        do { roomId=uuidv4().slice(0,6).toUpperCase(); } while(rooms[roomId]);
        rooms[roomId]={players:[null,null],state:createState()};
      }
      const room=rooms[roomId];
      myIndex=room.players[0]?1:0;
      room.players[myIndex]=ws; myRoom=room; ws.roomId=roomId;
      sendTo(ws,myIndex,{type:'joined',roomId,playerCount:room.players.filter(Boolean).length});
      if (room.players.filter(Boolean).length===2) bcast(room,{type:'ready'});
      return;
    }

    if (!myRoom) return;
    const s=myRoom.state;

    if (msg.type==='place') {
      if (s.phase!=='setup') return;
      const {shipId,col,row,dir}=msg;
      const def=SHIP_DEFS.find(d=>d.id===shipId); if(!def) return;
      const grid=s.grids[myIndex];
      Object.keys(grid).forEach(k=>{ if(grid[k]===shipId) delete grid[k]; });
      const cells=canPlace(grid,def.size,dir,col,row);
      if (!cells) { sendTo(ws,myIndex,{type:'placeErr',message:'無法放置（超界或太靠近）'}); sendState(myRoom); return; }
      Object.keys(cells).forEach(k=>grid[k]=shipId);
      const allPlaced=SHIP_DEFS.every(d=>Object.values(grid).includes(d.id));
      if (allPlaced) s.setupDone[myIndex]=true;
      sendState(myRoom);
      if (s.setupDone[0]&&s.setupDone[1]) {
        s.phase='battle'; s.currentTurn=0;
        bcast(myRoom,{type:'battleStart'}); sendState(myRoom);
      }
      return;
    }

    if (msg.type==='resetSetup') {
      if (s.phase!=='setup') return;
      s.grids[myIndex]={}; s.setupDone[myIndex]=false; sendState(myRoom); return;
    }

    if (msg.type==='fire') {
      if (s.phase!=='battle'||s.currentTurn!==myIndex) return;
      const {key}=msg; const opp=1-myIndex;
      const atkMap=s.attacks[myIndex]; if(atkMap[key]) return;
      const shipId=s.grids[opp][key];
      if (shipId) {
        atkMap[key]='hit';
        const allCells=Object.keys(s.grids[opp]).filter(k=>s.grids[opp][k]===shipId);
        const isSunk=allCells.every(k=>atkMap[k]==='hit'||atkMap[k]==='sunk');
        if (isSunk) {
          allCells.forEach(k=>atkMap[k]='sunk');
          s.sunk[myIndex].push(shipId);
          getNeighbors(allCells).forEach(k=>{ if(!atkMap[k]) atkMap[k]='cleared'; });
          s.logs.unshift(`玩家${myIndex+1} 在 ${key} 爆破！`);
          if (SHIP_DEFS.every(d=>s.sunk[myIndex].includes(d.id))) {
            s.phase='end'; sendState(myRoom); bcast(myRoom,{type:'win',winner:myIndex}); return;
          }
          sendState(myRoom); sendTo(ws,myIndex,{type:'result',result:'sunk',key});
        } else {
          s.logs.unshift(`玩家${myIndex+1} 在 ${key} 命中！`);
          sendState(myRoom); sendTo(ws,myIndex,{type:'result',result:'hit',key});
        }
      } else {
        atkMap[key]='miss';
        s.logs.unshift(`玩家${myIndex+1} 在 ${key} 未中`);
        s.currentTurn=opp; sendState(myRoom); sendTo(ws,myIndex,{type:'result',result:'miss',key});
      }
      return;
    }

    if (msg.type==='restart') {
      myRoom.state=createState(); bcast(myRoom,{type:'restart'}); sendState(myRoom);
    }
  });

  ws.on('close', ()=>{
    if (!myRoom) return;
    myRoom.players[myIndex]=null;
    bcast(myRoom,{type:'disconnect'});
    if (myRoom.players.every(p=>!p)) delete rooms[ws.roomId];
  });
});

server.listen(PORT, ()=>console.log(`Server on port ${PORT}`));
