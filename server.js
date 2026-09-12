// 游戏发布站 - 主服务
// 定位:本地 Agent(DeepSeek Harness / Claude Code / 任意 agent)发布 HTML 游戏的平台。
// 平台只负责:接收发布、托管文件、公开展示、试玩统计。不含任何游戏代码生成逻辑。
// 启动: node server.js  (或 npm start)
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const db = require('./lib/db');
const { loadConfig, saveConfig } = require('./lib/config');

const GAMES_DIR = path.join(__dirname, 'games');
fs.mkdirSync(GAMES_DIR, { recursive: true });
let config = loadConfig();

// 启动时确保有管理员令牌与登录密码(发布外网后保护后台)
if (!config.adminToken) {
  config.adminToken = crypto.randomBytes(16).toString('hex');
  saveConfig(config);
}
if (!config.adminPass) {
  config.adminPass = crypto.randomBytes(9).toString('base64url');
  saveConfig(config);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- 鉴权 ----------
// 令牌来源:URL ?token= 或请求头 x-admin-token(Agent 发布时也用这个)
function isAuthed(req) {
  const token = req.query.token || req.headers['x-admin-token'];
  return !!config.adminToken && token === config.adminToken;
}
function adminAuth(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'unauthorized', message: '需要登录或携带管理员令牌' });
  }
  next();
}

// 用户名 + 密码登录(公开接口),成功后返回会话令牌
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const okUser = String(username || '').trim() === String(config.adminUser || 'admin');
  const okPass = String(password || '') === String(config.adminPass || '');
  if (!okUser || !okPass) {
    return res.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
  }
  res.json({ ok: true, token: config.adminToken, user: config.adminUser, expireDays: 7 });
});

app.get('/api/auth/status', adminAuth, (req, res) => {
  res.json({ ok: true, user: config.adminUser });
});

app.post('/api/auth/change-password', adminAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (String(oldPassword || '') !== String(config.adminPass || '')) {
    return res.status(401).json({ error: 'wrong_password', message: '当前密码不正确' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'weak_password', message: '新密码至少 6 位' });
  }
  config.adminPass = String(newPassword);
  saveConfig(config);
  res.json({ ok: true });
});

// ---------- 公开页面与游戏文件 ----------
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
app.use('/assets', express.static(path.join(__dirname, 'public'), { setHeaders: noCache }));

app.get('/admin', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/play/:slug', (req, res) => {
  const game = db.prepare('SELECT id, slug, playable FROM games WHERE slug = ?').get(req.params.slug);
  if (!game || !game.playable) {
    return res.status(404).send('<h3 style="font-family:sans-serif">游戏不存在或未开放试玩</h3><p><a href="/">返回首页</a></p>');
  }
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

// 游戏本体文件:https://你的域名/g/<slug>/index.html
// 未开放公开试玩的游戏仅管理员可预览(需携带令牌)
app.use('/g', (req, res, next) => {
  const slug = req.path.split('/').filter(Boolean)[0];
  if (!slug) return next();
  const game = db.prepare('SELECT id, slug, playable FROM games WHERE slug = ?').get(slug);
  if (!game) return res.status(404).send('Game not found');
  if (!game.playable) {
    if (req.query.admin !== '1' || !isAuthed(req)) {
      return res.status(403).send('该游戏尚未开放公开试玩');
    }
  }
  next();
}, express.static(GAMES_DIR, { index: 'index.html', extensions: ['html'] }));

// ---------- 通用工具 ----------
function toPublicGame(g) {
  return {
    id: g.id, slug: g.slug, title: g.title, description: g.description,
    genre: g.genre, playable: !!g.playable, plays: g.plays,
    cover: g.cover, source: g.source,
    created_at: g.created_at, updated_at: g.updated_at,
  };
}

// 把相对路径安全解析到 games/<slug>/ 内,越界返回 null
function resolveGameFile(slug, rel) {
  if (!rel || rel.includes('\0')) return null;
  const base = path.join(GAMES_DIR, slug);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(d, ent.name), rel);
      } else {
        const st = fs.statSync(path.join(d, ent.name));
        out.push({ path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
      }
    }
  })(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------- API: 游戏列表 ----------
// 公开模式(?public=1):无需令牌,只返回公开可玩的游戏
app.get('/api/games', (req, res) => {
  if (req.query.public === '1') {
    const rows = db.prepare('SELECT * FROM games WHERE playable = 1 ORDER BY id DESC').all();
    return res.json({ games: rows.map(toPublicGame) });
  }
  adminAuth(req, res, () => {
    const rows = db.prepare('SELECT * FROM games ORDER BY id DESC').all();
    res.json({ games: rows.map(toPublicGame) });
  });
});

// ---------- API: 发布新游戏(Agent 入口) ----------
app.post('/api/games', adminAuth, (req, res) => {
  const { title, description = '', genre = '未分类', cover = '', source = '' } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '缺少标题' });

  // slug 只允许小写字母/数字/连字符;中文标题自动回退为 game-<n>
  let slug = String(req.body?.slug || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  slug = slug || 'game';
  let n = 1;
  while (db.prepare('SELECT id FROM games WHERE slug = ?').get(slug)) {
    slug = `${slug}-${n++}`;
  }

  const r = db.prepare(
    'INSERT INTO games (slug, title, description, genre, cover, source) VALUES (?,?,?,?,?,?)'
  ).run(slug, String(title).trim(), String(description).trim(), String(genre).trim(), cover, source);
  fs.mkdirSync(path.join(GAMES_DIR, slug), { recursive: true });

  res.json({ ok: true, id: r.lastInsertRowid, slug, playUrl: `/play/${slug}` });
});

// ---------- API: 游戏详情 / 修改 / 删除 ----------
app.get('/api/games/:slug', adminAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const dir = path.join(GAMES_DIR, g.slug);
  const files = fs.existsSync(dir) ? listFiles(dir) : [];
  const cutoff = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const stats = db.prepare(
    'SELECT date, plays FROM stats WHERE game_id = ? AND date >= ? ORDER BY date'
  ).all(g.id, cutoff);
  res.json({ game: toPublicGame(g), files, stats });
});

app.patch('/api/games/:slug', adminAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const allowed = ['title', 'description', 'genre', 'cover', 'source', 'playable'];
  const fields = {};
  for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
  if (fields.playable !== undefined) fields.playable = fields.playable ? 1 : 0;
  if (Object.keys(fields).length) {
    const set = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE games SET ${set}, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(...Object.values(fields), g.id);
  }
  res.json({ ok: true });
});

app.delete('/api/games/:slug', adminAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  db.prepare('DELETE FROM stats WHERE game_id = ?').run(g.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  const dir = path.join(GAMES_DIR, g.slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true, removed: g.slug });
});

// ---------- API: 游戏文件上传 / 删除 / 列表 ----------
// 上传文件: PUT /api/games/:slug/files/<相对路径>
// 请求体必须是原始字节(如 curl --data-binary @file),Content-Type 任意
app.put('/api/games/:slug/files/*', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const rel = String(req.params[0] || '').replace(/^\/+/, '');
  const target = resolveGameFile(g.slug, rel);
  if (!target) return res.status(400).json({ error: '非法路径' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: '请求体为空(请用 --data-binary @文件 上传原始字节)' });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, req.body);
  db.prepare("UPDATE games SET updated_at = datetime('now','localtime') WHERE id = ?").run(g.id);
  res.json({ ok: true, path: rel, bytes: req.body.length });
});

app.delete('/api/games/:slug/files/*', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const rel = String(req.params[0] || '').replace(/^\/+/, '');
  const target = resolveGameFile(g.slug, rel);
  if (!target) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  fs.unlinkSync(target);
  res.json({ ok: true, path: rel });
});

app.get('/api/games/:slug/files', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const dir = path.join(GAMES_DIR, g.slug);
  res.json({ files: fs.existsSync(dir) ? listFiles(dir) : [] });
});

// ---------- API: 试玩统计(公开) ----------
app.post('/api/games/:slug/play', (req, res) => {
  const g = db.prepare('SELECT id, slug, plays FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').run(g.id);
  db.prepare(
    `INSERT INTO stats (game_id, date, plays) VALUES (?, ?, 1)
     ON CONFLICT(game_id, date) DO UPDATE SET plays = plays + 1`
  ).run(g.id, today);
  res.json({ ok: true, total: g.plays + 1 });
});

// ---------- API: 状态与配置 ----------
app.get('/api/stats/overview', adminAuth, (req, res) => {
  res.json({
    totalGames: db.prepare('SELECT COUNT(*) c FROM games').get().c,
    liveGames: db.prepare('SELECT COUNT(*) c FROM games WHERE playable = 1').get().c,
    totalPlays: db.prepare('SELECT COALESCE(SUM(plays),0) s FROM games').get().s,
    todayPlays: db.prepare('SELECT COALESCE(SUM(plays),0) s FROM stats WHERE date = ?').get(new Date().toISOString().slice(0, 10)).s,
  });
});

app.get('/api/config', adminAuth, (req, res) => {
  res.json({ port: config.port, publicHost: config.publicHost, adminUser: config.adminUser, adminToken: config.adminToken });
});

app.post('/api/config', adminAuth, (req, res) => {
  if (req.body?.regenerateToken) {
    config.adminToken = crypto.randomBytes(16).toString('hex');
    saveConfig(config);
  }
  res.json({ ok: true, adminToken: config.adminToken });
});

// ---------- 启动 ----------
const host = config.publicHost ? '0.0.0.0' : '127.0.0.1';
app.listen(config.port, host, () => {
  console.log('==============================================');
  console.log('🎮 游戏发布站已启动(Agent 发布平台)');
  console.log(`   公开主页: http://${host}:${config.port}/`);
  console.log(`   管理后台: http://${host}:${config.port}/admin`);
  console.log(`   Agent 发布示例(单文件游戏):`);
  console.log(`     GAME_STATION_TOKEN=${config.adminToken} node scripts/publish.mjs /path/to/game-dir --title "游戏名" --publish`);
  console.log(`   🔑 后台登录: ${config.adminUser} / ${config.adminPass}`);
  console.log('==============================================');
});
