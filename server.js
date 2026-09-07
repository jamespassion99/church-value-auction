const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'church2026';
const STARTING_BALANCE = 365; // 單位：萬

// 三段喊價的等待秒數（毫秒）：第一次 3 秒後喊出、第二次再等 7 秒、第三次(成交)再等 15 秒
const DELAY_FIRST = 3000;
const DELAY_SECOND = 7000;
const DELAY_THIRD = 15000;

const itemsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items.json'), 'utf8'));

// 攤平成單一列表，並記錄狀態
const allItems = [];
for (const section of itemsData.sections) {
  for (const item of section.items) {
    allItems.push({
      id: item.id,
      title: item.title,
      sectionId: section.id,
      sectionTitle: section.title,
      status: 'pending', // pending | active | sold
      winnerName: null,
      soldPrice: null
    });
  }
}
function findItem(id) {
  return allItems.find((i) => i.id === id);
}

// 玩家資料：playerId -> { name, balance, socketId, connected }
const players = new Map();

// 目前競標狀態
const auction = {
  itemId: null,
  price: 0,
  leaderId: null,
  leaderName: null,
  callStage: 0, // 0=競標中/剛喊價, 1=第一次, 2=第二次, 3=成交
  status: 'idle', // idle | bidding | sold
  timer: null
};

let gameEnded = false;

function clearAuctionTimer() {
  if (auction.timer) {
    clearTimeout(auction.timer);
    auction.timer = null;
  }
}

function publicState() {
  const item = auction.itemId ? findItem(auction.itemId) : null;
  return {
    gameEnded,
    item: item
      ? { id: item.id, title: item.title, sectionTitle: item.sectionTitle }
      : null,
    price: auction.price,
    leaderName: auction.leaderName,
    callStage: auction.callStage,
    status: auction.status
  };
}

function itemsSummary() {
  return itemsData.sections.map((section) => ({
    id: section.id,
    title: section.title,
    items: section.items.map((it) => {
      const full = findItem(it.id);
      return {
        id: full.id,
        title: full.title,
        status: full.status,
        winnerName: full.winnerName,
        soldPrice: full.soldPrice
      };
    })
  }));
}

function playersSummary() {
  return Array.from(players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    balance: p.balance,
    connected: p.connected
  }));
}

function broadcastState() {
  io.emit('state:update', publicState());
  io.emit('items:update', itemsSummary());
  io.to('admins').emit('players:update', playersSummary());
}

function scheduleStage(nextStage, delay) {
  clearAuctionTimer();
  auction.timer = setTimeout(() => advanceStage(nextStage), delay);
}

function advanceStage(stage) {
  auction.callStage = stage;
  if (stage < 3) {
    broadcastState();
    const delay = stage === 1 ? DELAY_SECOND : DELAY_THIRD;
    scheduleStage(stage + 1, delay);
  } else {
    // 成交
    auction.status = 'sold';
    const item = findItem(auction.itemId);
    if (item) {
      item.status = 'sold';
      item.winnerName = auction.leaderName;
      item.soldPrice = auction.price;
      if (auction.leaderId && players.has(auction.leaderId)) {
        const p = players.get(auction.leaderId);
        p.balance -= auction.price;
      }
    }
    clearAuctionTimer();
    broadcastState();
  }
}

function startItem(itemId) {
  const item = findItem(itemId);
  if (!item) return { ok: false, reason: '找不到題目' };
  if (item.status === 'sold') return { ok: false, reason: '這一題已經賣出了' };
  if (auction.status === 'bidding') return { ok: false, reason: '目前有題目正在競標中，請先結束' };

  clearAuctionTimer();
  item.status = 'active';
  auction.itemId = itemId;
  auction.price = 0;
  auction.leaderId = null;
  auction.leaderName = null;
  auction.callStage = 0;
  auction.status = 'bidding';
  broadcastState();
  return { ok: true };
}

function cancelCurrentItem() {
  if (!auction.itemId) return;
  const item = findItem(auction.itemId);
  if (item && item.status === 'active') {
    item.status = 'pending';
  }
  clearAuctionTimer();
  auction.itemId = null;
  auction.price = 0;
  auction.leaderId = null;
  auction.leaderName = null;
  auction.callStage = 0;
  auction.status = 'idle';
  broadcastState();
}

function placeBid(playerId, amount) {
  if (auction.status !== 'bidding') return { ok: false, reason: '目前沒有正在競標的題目' };
  if (!players.has(playerId)) return { ok: false, reason: '找不到玩家，請重新加入' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: '請輸入正整數金額' };

  const player = players.get(playerId);
  if (amount <= auction.price) return { ok: false, reason: `喊價必須高於目前價格 ${auction.price} 萬` };
  if (amount > player.balance) return { ok: false, reason: `籌碼不足，你剩下 ${player.balance} 萬` };
  if (playerId === auction.leaderId) return { ok: false, reason: '你目前已經是最高出價者' };

  auction.price = amount;
  auction.leaderId = playerId;
  auction.leaderName = player.name;
  auction.callStage = 0;
  scheduleStage(1, DELAY_FIRST);
  broadcastState();
  return { ok: true };
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

const server = require('http').createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  socket.emit('state:update', publicState());
  socket.emit('items:update', itemsSummary());

  socket.on('player:join', ({ playerId, name }, cb) => {
    name = (name || '').toString().trim().slice(0, 20);
    if (!name) return cb && cb({ ok: false, reason: '請輸入名字' });

    let id = playerId;
    let player = id && players.has(id) ? players.get(id) : null;

    if (!player) {
      id = crypto.randomUUID();
      player = { name, balance: STARTING_BALANCE, socketId: socket.id, connected: true };
      players.set(id, player);
    } else {
      player.name = name;
      player.socketId = socket.id;
      player.connected = true;
    }

    socket.data.playerId = id;
    socket.join('players');
    cb && cb({ ok: true, playerId: id, name: player.name, balance: player.balance });
    io.to('admins').emit('players:update', playersSummary());
  });

  socket.on('bid:submit', ({ amount }, cb) => {
    const playerId = socket.data.playerId;
    if (!playerId) return cb && cb({ ok: false, reason: '請先加入遊戲' });
    const result = placeBid(playerId, Number(amount));
    cb && cb(result);
  });

  socket.on('admin:login', (password, cb) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      cb && cb({ ok: true });
      socket.emit('players:update', playersSummary());
    } else {
      cb && cb({ ok: false, reason: '密碼錯誤' });
    }
  });

  socket.on('admin:startItem', (itemId, cb) => {
    if (!socket.rooms.has('admins')) return cb && cb({ ok: false, reason: '未登入管理者' });
    cb && cb(startItem(itemId));
  });

  socket.on('admin:cancelItem', (_data, cb) => {
    if (!socket.rooms.has('admins')) return cb && cb({ ok: false, reason: '未登入管理者' });
    cancelCurrentItem();
    cb && cb({ ok: true });
  });

  socket.on('admin:endGame', (_data, cb) => {
    if (!socket.rooms.has('admins')) return cb && cb({ ok: false, reason: '未登入管理者' });
    gameEnded = true;
    broadcastState();
    cb && cb({ ok: true });
  });

  socket.on('admin:resetGame', (_data, cb) => {
    if (!socket.rooms.has('admins')) return cb && cb({ ok: false, reason: '未登入管理者' });
    cancelCurrentItem();
    gameEnded = false;
    for (const item of allItems) {
      item.status = 'pending';
      item.winnerName = null;
      item.soldPrice = null;
    }
    for (const p of players.values()) {
      p.balance = STARTING_BALANCE;
    }
    broadcastState();
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    if (playerId && players.has(playerId)) {
      players.get(playerId).connected = false;
      io.to('admins').emit('players:update', playersSummary());
    }
  });
});

server.listen(PORT, () => {
  console.log(`教會競標遊戲伺服器啟動：http://localhost:${PORT}`);
  console.log(`管理者頁面：http://localhost:${PORT}/admin`);
  console.log(`投影頁面：http://localhost:${PORT}/display`);
});
