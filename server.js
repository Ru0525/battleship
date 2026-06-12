const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// rooms: { roomId: { players: [ws, ws], state: GameState } }
const rooms = {};

const SHIP_DEFS = [
  { id: 's3', size: 3 },
  { id: 's2a', size: 2 },
  { id: 's2b', size: 2 },
  { id: 's1', size: 1 },
];
const COLS = ['A','B','C','D','E'];

function getNeighbors(cellKeys) {
  const nb = new Set();
  cellKeys.forEach(k => {
    const c = k[0], r = parseInt(k[1]);
    const ci = COLS.indexOf(c);
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const nc = COLS[ci + dc], nr = r + dr;
      if (nc && nr >= 1 && nr <= 5) nb.add(nc + nr);
    }
  });
  return nb;
}

function canPlace(grid, size, dir, col, row) {
  const ci = COLS.indexOf(col), r = parseInt(row);
  const toOccupy = {};
  for (let i = 0; i < size; i++) {
    let key;
    if (dir === 'H') { const nc = COLS[ci + i]; if (!nc) return null; key = nc + r; }
    else { const nr = r + i; if (nr > 5) return null; key = col + nr; }
    toOccupy[key] = true;
  }
  const nb = getNeighbors(Object.keys(grid));
  for (const k of Object.keys(toOccupy)) {
    if (grid[k]) return null;
    if (nb.has(k)) return null;
  }
  return toOccupy;
}

function createGameState() {
  return {
    phase: 'setup',       // setup | battle | end
    grids: [{}, {}],      // grids[0] = P1 ships, grids[1] = P2 ships
    attacks: [{}, {}],    // attacks[0] = P1 attack map on P2, attacks[1] = P2 attack map on P1
    sunk: [[], []],       // sunk[0] = ships sunk by P1
    setupDone: [false, false],
    currentTurn: 0,       // 0=P1, 1=P2
    logs: [],
  };
}

function broadcast(room, msg) {
  room.players.forEach((ws, i) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...msg, myIndex: i }));
  });
}

function send(ws, idx, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...msg, myIndex: idx }));
}

function sendState(room) {
  const s = room.state;
  room.players.forEach((ws, i) => {
    if (!ws || ws.readyState !== 1) return;
    const opp = 1 - i;
    // send own grid (with ships), opponent attack map, opponent grid (no ships), own attack map
    ws.send(JSON.stringify({
      type: 'state',
      myIndex: i,
      phase: s.phase,
      currentTurn: s.currentTurn,
      myGrid: s.grids[i],
      oppAttackOnMe: s.attacks[opp],   // what opponent fired at me
      myAttackOnOpp: s.attacks[i],     // what I fired at opponent
      oppGrid: hideShips(s.grids[opp], s.attacks[i], s.sunk[i]),
      setupDone: s.setupDone,
      sunkByMe: s.sunk[i],
      sunkOnMe: s.sunk[opp],
      logs: s.logs.slice(0, 20),
    }));
  });
}

function hideShips(grid, attackMap, sunkByMe) {
  const result = {};
  Object.keys(grid).forEach(k => {
    const sid = grid[k];
    if (sunkByMe.includes(sid)) result[k] = sid;
  });
  return result;
}

wss.on('connection', (ws) => {
  let myRoom = null, myIndex = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // Find room with 1 player waiting, or create new
      let roomId = null;
      for (const [id, r] of Object.entries(rooms)) {
        if (r.players.filter(Boolean).length === 1) { roomId = id; break; }
      }
      if (!roomId) {
        roomId = uuidv4().slice(0, 6).toUpperCase();
        rooms[roomId] = { players: [null, null], state: createGameState() };
      }
      const room = rooms[roomId];
      myIndex = room.players[0] ? 1 : 0;
      room.players[myIndex] = ws;
      myRoom = room;
      ws.roomId = roomId;

      send(ws, myIndex, { type: 'joined', roomId, playerCount: room.players.filter(Boolean).length });

      if (room.players.filter(Boolean).length === 2) {
        broadcast(room, { type: 'ready', message: '兩位玩家已連線，開始佈陣！' });
      }
      return;
    }

    if (!myRoom) return;
    const s = myRoom.state;

    if (msg.type === 'place') {
      if (s.phase !== 'setup') return;
      const { shipId, col, row, dir } = msg;
      const def = SHIP_DEFS.find(d => d.id === shipId);
      if (!def) return;
      const grid = s.grids[myIndex];
      if (Object.values(grid).includes(shipId)) return; // already placed
      const cells = canPlace(grid, def.size, dir, col, row);
      if (!cells) { send(ws, myIndex, { type: 'placeErr', message: '無法放置（超界或太靠近）' }); return; }
      Object.keys(cells).forEach(k => grid[k] = shipId);
      const allPlaced = SHIP_DEFS.every(d => Object.values(grid).includes(d.id));
      if (allPlaced) s.setupDone[myIndex] = true;
      sendState(myRoom);
      if (s.setupDone[0] && s.setupDone[1]) {
        s.phase = 'battle';
        s.currentTurn = 0;
        broadcast(myRoom, { type: 'battleStart' });
        sendState(myRoom);
      }
      return;
    }

    if (msg.type === 'fire') {
      if (s.phase !== 'battle') return;
      if (s.currentTurn !== myIndex) { send(ws, myIndex, { type: 'err', message: '還沒輪到你' }); return; }
      const { key } = msg;
      const opp = 1 - myIndex;
      const atkMap = s.attacks[myIndex];
      if (atkMap[key]) return;
      const targetGrid = s.grids[opp];
      const shipId = targetGrid[key];

      if (shipId) {
        atkMap[key] = 'hit';
        const allCells = Object.keys(targetGrid).filter(k => targetGrid[k] === shipId);
        const isSunk = allCells.every(k => atkMap[k] === 'hit' || atkMap[k] === 'sunk');
        if (isSunk) {
          allCells.forEach(k => atkMap[k] = 'sunk');
          s.sunk[myIndex].push(shipId);
          const nb = getNeighbors(allCells);
          nb.forEach(k => { if (!atkMap[k]) atkMap[k] = 'cleared'; });
          s.logs.unshift(`玩家${myIndex+1} 在 ${key} 爆破！`);
          const allSunk = SHIP_DEFS.every(d => s.sunk[myIndex].includes(d.id));
          if (allSunk) {
            s.phase = 'end';
            sendState(myRoom);
            broadcast(myRoom, { type: 'win', winner: myIndex });
            return;
          }
          sendState(myRoom);
          send(ws, myIndex, { type: 'result', result: 'sunk', key });
        } else {
          s.logs.unshift(`玩家${myIndex+1} 在 ${key} 命中！`);
          sendState(myRoom);
          send(ws, myIndex, { type: 'result', result: 'hit', key });
        }
        // hit/sunk → same player continues, no turn switch
      } else {
        atkMap[key] = 'miss';
        s.logs.unshift(`玩家${myIndex+1} 在 ${key} 未中`);
        s.currentTurn = opp;
        sendState(myRoom);
        send(ws, myIndex, { type: 'result', result: 'miss', key });
      }
      return;
    }

    if (msg.type === 'resetSetup') {
      if (s.phase !== 'setup') return;
      s.grids[myIndex] = {};
      s.setupDone[myIndex] = false;
      sendState(myRoom);
      return;
    }

    if (msg.type === 'restart') {
      myRoom.state = createGameState();
      broadcast(myRoom, { type: 'restart' });
      sendState(myRoom);
    }
  });

  ws.on('close', () => {
    if (myRoom) {
      myRoom.players[myIndex] = null;
      broadcast(myRoom, { type: 'disconnect', message: '對手已離線' });
      if (myRoom.players.every(p => !p)) delete rooms[ws.roomId];
    }
  });
});

server.listen(PORT, () => console.log(`Battleship server on port ${PORT}`));
