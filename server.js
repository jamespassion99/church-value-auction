const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'church2026';
const STARTING_BALANCE = 365; // 單位：萬

const itemsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items.json'), 'utf8'));

// 攤平成單一列表
const allItems = [];
for (const section of itemsData.sections) {
  for (const item of section.items) {
    allItems.push({
      id: item.id,
      title: item.title,
      price: item.price,
      sectionId: section.id,
      sectionTitle: section.title
    });
  }
}
function findItem(id) {
  return allItems.find((i) => i.id === id);
}

// 玩家資料：playerId -> { name, balance, socketId, connected, purchases: Map(itemId -> price) }
const players = new Map();

let gameEnded = false;

function buyerCount(itemId) {
  let count = 0;
  for (const p of players.values()) {
    if (p.purchases.has(itemId)) count++;
  }
  return count;
}

function playerPurchases(player) {
  const list = [];
  for (const [itemId, price] of player.purchases.entries()) {
    const item = findItem(itemId);
    if (item) list.push({ itemId, title: item.title, price, sectionTitle: item.sectionTitle });
  }
  return list;
}

function publicState() {
  return { gameEnded };
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
        price: full.price,
        buyerCount: buyerCount(full.id)
      };
    })
  }));
}

function playersSummary() {
  return Array.from(players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    balance: p.balance,
    connected: p.connected,
    confirmed: p.confirmed,
    purchases: playerPurchases(p)
  }));
}

function broadcastState() {
  io.emit('state:update', publicState());
  io.emit('items:update', itemsSummary());
  io.to('admins').emit('players:update', playersSummary());
}

function confirmPurchases(playerId, itemIds) {
  if (!players.has(playerId)) return { ok: false, reason: '找不到玩家，請重新加入' };
  const player = players.get(playerId);
  if (player.confirmed) return { ok: false, reason: '你已經送出過選擇了，無法再修改' };

  const ids = Array.from(new Set((itemIds || []).map(String)));
  const items = [];
  for (const id of ids) {
    const item = findItem(id);
    if (!item) return { ok: false, reason: '找不到項目：' + id };
    items.push(item);
  }
  const total = items.reduce((sum, it) => sum + it.price, 0);
  if (total > player.balance) return { ok: false, reason: `籌碼不足，這些項目共需 ${total} 萬，你只剩 ${player.balance} 萬` };

  for (const item of items) player.purchases.set(item.id, item.price);
  player.balance -= total;
  player.confirmed = true;
  broadcastState();
  return { ok: true, balance: player.balance, confirmed: true, purchases: playerPurchases(player) };
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
      player = { name, balance: STARTING_BALANCE, socketId: socket.id, connected: true, confirmed: false, purchases: new Map() };
      players.set(id, player);
    } else {
      player.name = name;
      player.socketId = socket.id;
      player.connected = true;
    }

    socket.data.playerId = id;
    socket.join('players');
    cb && cb({ ok: true, playerId: id, name: player.name, balance: player.balance, confirmed: player.confirmed, purchases: playerPurchases(player) });
    io.to('admins').emit('players:update', playersSummary());
  });

  socket.on('player:confirmPurchases', ({ itemIds }, cb) => {
    const playerId = socket.data.playerId;
    if (!playerId) return cb && cb({ ok: false, reason: '請先加入遊戲' });
    cb && cb(confirmPurchases(playerId, itemIds));
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

  socket.on('admin:updateItem', ({ itemId, title, price }, cb) => {
    if (!socket.rooms.has('admins')) return cb && cb({ ok: false, reason: '未登入管理者' });
    const item = findItem(itemId);
    if (!item) return cb && cb({ ok: false, reason: '找不到項目' });
    if (buyerCount(itemId) > 0) return cb && cb({ ok: false, reason: '已經有人買了這個項目，無法再修改' });

    title = (title || '').toString().trim().slice(0, 60);
    const priceNum = Number(price);
    if (!title) return cb && cb({ ok: false, reason: '項目名稱不能空白' });
    if (!Number.isInteger(priceNum) || priceNum <= 0) return cb && cb({ ok: false, reason: '價格必須是正整數' });

    item.title = title;
    item.price = priceNum;
    broadcastState();
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
    gameEnded = false;
    for (const p of players.values()) {
      p.balance = STARTING_BALANCE;
      p.confirmed = false;
      p.purchases.clear();
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
