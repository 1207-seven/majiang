/*
 * 摸牌添喜 · 后端服务（零依赖，Node 14+）
 * 启动：node server.js   （PORT 环境变量可改端口，默认 8910）
 * 数据：data/rooms.json（自动创建）
 * 接口：
 *   POST /api/rooms                {prizeId, prob}            -> {roomId, hostLink}
 *   GET  /api/rooms/:id                                        -> {prizeId, prob, total, closed}
 *   POST /api/rooms/:id/draw       {name, did}                -> {tileId, win, total}
 *   GET  /api/rooms/:id/results?k=hostKey                      -> {total, winCount, draws:[...]}
 *   POST /api/rooms/:id/close      {k: hostKey}               -> {ok}
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8910);
const ROOM_TTL = 7 * 24 * 3600 * 1000; // 房间 7 天过期
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ==================== 存储 ==================== */
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { /* 首次启动 */ }

let flushTm = null;
function flush() {
  clearTimeout(flushTm);
  flushTm = setTimeout(function () {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
    } catch (e) { console.error('[flush]', e.message); }
  }, 200);
}

/* 顺手清理过期房间 */
function cleanExpired() {
  var now = Date.now(), dirty = false;
  for (var id in rooms) {
    if (now - rooms[id].createdAt > ROOM_TTL) { delete rooms[id]; dirty = true; }
  }
  if (dirty) flush();
}

/* ==================== 牌库（与前端一致） ==================== */
const ZI_LIST = ['dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'];
const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const SUIT_CH = { wan: '萬', tiao: '條', tong: '筒' };
const TILE_IDS = (function () {
  var ids = [];
  ['wan', 'tiao', 'tong'].forEach(function (s) {
    for (var n = 1; n <= 9; n++) ids.push(s + '-' + n);
  });
  ZI_LIST.forEach(function (z) { ids.push('zi-' + z); });
  return ids;
})();
function tileLabel(id) {
  var m = /^(wan|tiao|tong)-(\d)$/.exec(id);
  if (m) return CN_NUM[Number(m[2])] + SUIT_CH[m[1]];
  var z = id.slice(3);
  var map = { dong: '東', nan: '南', xi: '西', bei: '北', zhong: '中', fa: '發', bai: '白板' };
  return map[z] || id;
}

/* ==================== 工具 ==================== */
function send(res, code, data, headers) {
  var body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'close'
  }, headers || {}));
  res.end(body);
}
function readBody(req, cb) {
  var chunks = [], size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > 4096) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    var raw = Buffer.concat(chunks).toString('utf8');
    try { cb(null, raw ? JSON.parse(raw) : {}); }
    catch (e) { cb(e); }
  });
  req.on('error', function (e) { cb(e); });
}
function roomPublic(r) {
  return { prizeId: r.prizeId, prizeLabel: tileLabel(r.prizeId), prob: r.prob, total: r.draws.length, closed: r.closed };
}

/* ==================== API 路由 ==================== */
function handleAPI(req, res, pathname, query) {
  var parts = pathname.split('/').filter(Boolean); // ['api', ...]

  /* 建房 */
  if (req.method === 'POST' && pathname === '/api/rooms') {
    readBody(req, function (err, body) {
      if (err) return send(res, 400, { error: '参数错误' });
      var prizeId = String(body.prizeId || '');
      var prob = Number(body.prob);
      if (TILE_IDS.indexOf(prizeId) < 0) return send(res, 400, { error: '中奖牌无效' });
      if (!(prob >= 0 && prob <= 100)) return send(res, 400, { error: '概率需在 0-100' });
      var id, hostKey;
      do { id = crypto.randomBytes(4).toString('hex'); } while (rooms[id]);
      hostKey = crypto.randomBytes(8).toString('hex');
      rooms[id] = { prizeId: prizeId, prob: Math.round(prob), hostKey: hostKey, closed: false, createdAt: Date.now(), draws: [] };
      flush();
      send(res, 200, { roomId: id, hostKey: hostKey });
    });
    return;
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return send(res, 404, { error: 'not found' });
  var roomId = parts[2];
  var room = rooms[roomId];
  if (!room || Date.now() - room.createdAt > ROOM_TTL) return send(res, 404, { error: '房间不存在或已过期' });

  /* 房间信息（参与者拉取） */
  if (req.method === 'GET' && parts.length === 3) {
    return send(res, 200, roomPublic(room));
  }

  /* 摸牌 */
  if (req.method === 'POST' && parts[3] === 'draw') {
    readBody(req, function (err, body) {
      if (err) return send(res, 400, { error: '参数错误' });
      if (room.closed) return send(res, 410, { error: '本局已结束，不能再摸了' });
      var name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 12);
      var did = String(body.did || '').slice(0, 40);
      if (!name) return send(res, 400, { error: '先填一个昵称' });
      if (!did) return send(res, 400, { error: '设备标识缺失' });

      var dup = room.draws.some(function (d) {
        return d.name.toLowerCase() === name.toLowerCase() || d.did === did;
      });
      if (dup) return send(res, 409, { error: 'DUP' });

      var tileId = TILE_IDS[Math.floor(Math.random() * TILE_IDS.length)];
      var win = Math.random() * 100 < room.prob;
      room.draws.push({ name: name, tileId: tileId, win: win, ts: Date.now(), did: did });
      flush();
      send(res, 200, { tileId: tileId, tileLabel: tileLabel(tileId), win: win, total: room.draws.length });
    });
    return;
  }

  /* 发起人查结果 */
  if (req.method === 'GET' && parts[3] === 'results') {
    if (query.get('k') !== room.hostKey) return send(res, 403, { error: '无权查看' });
    send(res, 200, {
      total: room.draws.length,
      winCount: room.draws.filter(function (d) { return d.win; }).length,
      closed: room.closed,
      prob: room.prob,
      prizeLabel: tileLabel(room.prizeId),
      draws: room.draws.map(function (d) {
        return { name: d.name, tileId: d.tileId, tileLabel: tileLabel(d.tileId), win: d.win, ts: d.ts };
      })
    });
    return;
  }

  /* 结束本局 */
  if (req.method === 'POST' && parts[3] === 'close') {
    readBody(req, function (err, body) {
      if (err) return send(res, 400, { error: '参数错误' });
      if (body.k !== room.hostKey) return send(res, 403, { error: '无权操作' });
      room.closed = true;
      flush();
      send(res, 200, { ok: true });
    });
    return;
  }

  send(res, 404, { error: 'not found' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
/* 按页面注入微信分享卡片所需的 meta：微信抓取的是服务端 HTML，JS 动态改的 meta 无效 */
function shareMeta(req, page, roomId) {
  var host = req.headers.host || ('localhost:' + PORT);
  var proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  var base = proto + '://' + host;
  var title = '摸牌添喜 · 麻将摸彩';
  var desc = '发起一局麻将摸彩，点开摸一张，看看今天手气如何。';
  if (page === 'join') {
    var r = rooms[roomId];
    if (r && Date.now() - r.createdAt <= ROOM_TTL) {
      var label = tileLabel(r.prizeId);
      title = '摸牌添喜 · 「' + label + '」摸牌中';
      desc = '摸到「' + label + '」即中奖！中奖率 ' + r.prob + '% · 点开摸一张试试手气。';
    }
  } else if (page === 'host') {
    title = '摸牌添喜 · 本局战况';
    desc = '查看参与名单与中奖结果。';
  }
  return '<title>' + escapeHtml(title) + '</title>'
    + '\n<meta name="description" content="' + escapeHtml(desc) + '">'
    + '\n<meta property="og:title" content="' + escapeHtml(title) + '">'
    + '\n<meta property="og:description" content="' + escapeHtml(desc) + '">'
    + '\n<meta property="og:type" content="website">'
    + '\n<meta property="og:image" content="' + escapeHtml(base + '/share-cover.png') + '">'
    + '\n<meta itemprop="name" content="' + escapeHtml(title) + '">'
    + '\n<meta itemprop="description" content="' + escapeHtml(desc) + '">'
    + '\n<meta itemprop="image" content="' + escapeHtml(base + '/share-cover.png') + '">';
}

/* ==================== 静态文件 ==================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};
/* 整体替换 <!--SHARE_META--> … <!--/SHARE_META--> 之间的静态兜底块，保证页面只有一份 meta */
function injectMeta(html, metaTags) {
  var re = /<!--SHARE_META-->[\s\S]*?<!--\/SHARE_META-->/;
  if (re.test(html)) return html.replace(re, metaTags);
  return html.replace('<!--SHARE_META-->', metaTags);
}
function servePage(req, res, page, roomId) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), function (err, buf) {
    if (err) return send(res, 404, 'not found');
    var html = injectMeta(buf.toString('utf8'), shareMeta(req, page, roomId));
    send(res, 200, html, { 'Content-Type': MIME['.html'] });
  });
}
function serveStatic(req, res, pathname) {
  var seg = pathname.split('/').filter(Boolean);
  /* 页面路由（真实路径，不用 # 片段）：微信转发会分享当前地址，
     所以参与页必须是一个独立、可直接打开的 URL */
  if (pathname === '/' || pathname === '/new') return servePage(req, res, 'new');
  if (seg.length === 2 && seg[0] === 'r') return servePage(req, res, 'join', seg[1]);
  if (seg[0] === 'h' && seg.length <= 3) return servePage(req, res, 'host', seg[1]);
  var rel = pathname === '/' ? '/index.html' : pathname;
  var file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, function (err, buf) {
    if (err) {
      /* 前端 hash 路由：非 API 且带扩展名的 404 原样返回，否则回 index.html */
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), function (e2, buf2) {
          if (e2) return send(res, 404, 'not found');
          var html = injectMeta(buf2.toString('utf8'), shareMeta(req, 'new'));
          send(res, 200, html, { 'Content-Type': MIME['.html'] });
        });
        return;
      }
      return send(res, 404, 'not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* ==================== 服务入口 ==================== */
cleanExpired();
setInterval(cleanExpired, 3600 * 1000);

const server = http.createServer(function (req, res) {
  var u = new URL(req.url, 'http://x');
  var pathname = decodeURIComponent(u.pathname);
  if (pathname.startsWith('/api/')) return handleAPI(req, res, pathname, u.searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  serveStatic(req, res, pathname);
});

server.listen(PORT, function () {
  console.log('[摸牌添喜] 服务已启动: http://127.0.0.1:' + PORT);
});
