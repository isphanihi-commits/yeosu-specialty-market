import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';

const app = express();
const server = createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const VEGS = ['corn', 'mustard', 'mugwort', 'bangpung', 'dureup'];
const names = { corn: '화양옥수수', mustard: '돌산갓', mugwort: '거문도해풍쑥', bangpung: '금오도방풍', dureup: '돌산두릅' };
const EVENTS = [
  { type: 'demand', veg: 'mustard', amount: 3, title: '갓김치 주문 폭주', text: '돌산갓 수요가 늘어 가격이 3 상승합니다.' },
  { type: 'demand', veg: 'mugwort', amount: 3, title: '봄철 건강식 열풍', text: '거문도해풍쑥 수요가 늘어 가격이 3 상승합니다.' },
  { type: 'demand', veg: 'corn', amount: 3, title: '여름 간식 인기', text: '화양옥수수 수요가 늘어 가격이 3 상승합니다.' },
  { type: 'demand', veg: 'bangpung', amount: 3, title: '섬 밥상 방송', text: '금오도방풍 수요가 늘어 가격이 3 상승합니다.' },
  { type: 'demand', veg: 'dureup', amount: 3, title: '제철 미식가 추천', text: '돌산두릅 수요가 늘어 가격이 3 상승합니다.' },
  { type: 'supply', veg: 'corn', amount: 3, title: '화양옥수수 풍년', text: '화양옥수수 공급이 늘어 가격이 3 하락합니다.' },
  { type: 'supply', veg: 'mustard', amount: 3, title: '돌산갓 대량 출하', text: '돌산갓 공급이 늘어 가격이 3 하락합니다.' },
  { type: 'supply', veg: 'mugwort', amount: 3, title: '해풍쑥 풍작', text: '거문도해풍쑥 공급이 늘어 가격이 3 하락합니다.' }
];
const rooms = new Map();

function makeCard() {
  const card = Object.fromEntries(VEGS.map(v => [v, 0]));
  for (let n = 0; n < 3; n++) card[VEGS[Math.floor(Math.random() * VEGS.length)]]++;
  return { id: randomUUID(), veg: card };
}
function freshRoom(code) {
  return { code, host: null, phase: 'lobby', round: 0, players: [], prices: Object.fromEntries(VEGS.map(v => [v, 10])), market: [], activeIndex: 0, event: null, lastChange: null, message: '플레이어를 기다리는 중입니다.' };
}
function publicState(room) {
  return {
    code: room.code, host: room.host, phase: room.phase, round: room.round, players: room.players.map(({ id, ...p }) => p),
    prices: room.prices, market: room.market, activeIndex: room.activeIndex, event: room.event, lastChange: room.lastChange, message: room.message, vegNames: names
  };
}
function emitRoom(room) { io.to(room.code).emit('state', publicState(room)); }
function resetGame(room) {
  room.phase = 'playing'; room.round = 1; room.prices = Object.fromEntries(VEGS.map(v => [v, 10]));
  room.players.forEach(p => p.inventory = Object.fromEntries(VEGS.map(v => [v, 0])));
  room.activeIndex = 0; room.lastChange = null; deal(room);
}
function deal(room) {
  room.market = Array.from({ length: room.players.length + 1 }, makeCard);
  room.event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  room.message = `${room.players[room.activeIndex].name}님의 차례입니다.`;
}
function settleRound(room) {
  const leftover = room.market[0];
  // A card left unsold signals a strong surplus; absent goods signal scarcity.
  const changes = Object.fromEntries(VEGS.map(v => [v, leftover.veg[v] ? -2 * leftover.veg[v] : 2]));
  changes[room.event.veg] += room.event.type === 'demand' ? room.event.amount : -room.event.amount;
  for (const veg of VEGS) {
    const before = room.prices[veg];
    room.prices[veg] = Math.max(0, Math.min(20, before + changes[veg]));
    changes[veg] = room.prices[veg] - before;
  }
  room.lastChange = { leftover: leftover.veg, event: room.event, changes };
  if (room.round === 6) {
    room.phase = 'finished';
    room.players.forEach(p => p.gold = VEGS.reduce((sum, v) => sum + p.inventory[v] * room.prices[v], 0));
    const high = Math.max(...room.players.map(p => p.gold));
    const winners = room.players.filter(p => p.gold === high).map(p => p.name).join(', ');
    room.message = `${winners} 님 우승! (${high} 골드)`;
    return;
  }
  room.round++;
  // The current player was the last picker. Advance from the previous
  // round's first player by one: e.g. A→B→C→D means the next round starts B.
  room.activeIndex = (room.activeIndex + 2) % room.players.length;
  deal(room);
}

io.on('connection', socket => {
  socket.on('join', ({ code, name }) => {
    code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    name = String(name || '').trim().slice(0, 16);
    if (!code || !name) return socket.emit('errorMessage', '방 코드와 이름을 입력해 주세요.');
    let room = rooms.get(code);
    if (!room) { room = freshRoom(code); rooms.set(code, room); }
    if (room.phase !== 'lobby') return socket.emit('errorMessage', '이미 진행 중인 게임입니다.');
    if (room.players.length >= 8) return socket.emit('errorMessage', '방이 가득 찼습니다.');
    if (room.players.some(p => p.name === name)) return socket.emit('errorMessage', '이 방에서는 다른 이름을 사용해 주세요.');
    const player = { id: socket.id, name, inventory: Object.fromEntries(VEGS.map(v => [v, 0])), gold: 0 };
    room.players.push(player); if (!room.host) room.host = socket.id;
    socket.join(code); socket.data.room = code; socket.data.player = socket.id;
    room.message = `${name} 님이 참가했습니다. (2~8명)`; emitRoom(room);
  });
  socket.on('start', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) return socket.emit('errorMessage', '2명 이상 필요합니다.');
    resetGame(room); emitRoom(room);
  });
  socket.on('pick', cardId => {
    const room = rooms.get(socket.data.room);
    if (!room || room.phase !== 'playing') return;
    const current = room.players[room.activeIndex];
    if (current.id !== socket.id) return socket.emit('errorMessage', '현재 차례가 아닙니다.');
    const index = room.market.findIndex(c => c.id === cardId);
    if (index < 0) return;
    const [card] = room.market.splice(index, 1);
    VEGS.forEach(v => current.inventory[v] += card.veg[v]);
    if (room.market.length === 1) settleRound(room);
    else { room.activeIndex = (room.activeIndex + 1) % room.players.length; room.message = `${room.players[room.activeIndex].name}님의 차례입니다.`; }
    emitRoom(room);
  });
  socket.on('restart', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.host !== socket.id || room.phase !== 'finished') return;
    resetGame(room);
    emitRoom(room);
  });
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room); if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id); if (idx < 0) return;
    const [left] = room.players.splice(idx, 1);
    if (!room.players.length) return rooms.delete(room.code);
    if (room.host === socket.id) room.host = room.players[0].id;
    if (room.phase === 'playing') { room.phase = 'lobby'; room.message = `${left.name} 님이 나가 게임이 중단되었습니다.`; }
    emitRoom(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Market Garden running on port 3000'));
