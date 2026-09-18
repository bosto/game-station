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

// 运行目录支持环境变量覆盖,便于 CI/测试隔离:
//   GAME_STATION_GAMES_DIR / GAME_STATION_DATA_DIR / GAME_STATION_CONFIG
const GAMES_DIR = process.env.GAME_STATION_GAMES_DIR || path.join(__dirname, 'games');
const DATA_DIR = process.env.GAME_STATION_DATA_DIR || require('./lib/db').DATA_DIR;
// 暂存目录(原子发布用,不在公网静态服务范围)与发布快照目录(回滚用,同样私密)
const STAGING_DIR = process.env.GAME_STATION_STAGING_DIR || path.join(DATA_DIR, 'staging');
const RELEASES_DIR = process.env.GAME_STATION_RELEASES_DIR || path.join(DATA_DIR, 'releases');
// 交付物目录(由 game-cli 构建,含 web.zip/source.zip/校验报告)
const ARTIFACTS_DIR = process.env.GAME_STATION_ARTIFACTS_DIR || path.join(__dirname, 'artifacts');
fs.mkdirSync(GAMES_DIR, { recursive: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });
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

// 把相对路径安全解析到 base 目录内,越界返回 null
function resolveGameFile(base, rel) {
  if (!rel || rel.includes('\0')) return null;
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// 计算一个目录内全部文件的总字节数(用于 release 记录)
function dirBytes(dir) {
  let total = 0;
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  })(dir);
  return total;
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
  db.prepare('DELETE FROM releases WHERE game_id = ?').run(g.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  const dir = path.join(GAMES_DIR, g.slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const relDir = path.join(RELEASES_DIR, g.slug);
  if (fs.existsSync(relDir)) fs.rmSync(relDir, { recursive: true, force: true });
  const stagDir = path.join(STAGING_DIR, g.slug);
  if (fs.existsSync(stagDir)) fs.rmSync(stagDir, { recursive: true, force: true });
  res.json({ ok: true, removed: g.slug });
});

// ---------- API: 游戏文件上传 / 删除 / 列表 ----------
// 上传文件: PUT /api/games/:slug/files/<相对路径>
// 请求体必须是原始字节(如 curl --data-binary @file),Content-Type 任意
// 鉴权在 express.raw 之前执行,未授权请求不会触发请求体解析。
// ?stage=1 时写入私密暂存目录(不公开),配合 POST /activate 原子发布。
app.put('/api/games/:slug/files/*', adminAuth, express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const rel = String(req.params[0] || '').replace(/^\/+/, '');
  const base = req.query.stage === '1'
    ? path.join(STAGING_DIR, g.slug)
    : path.join(GAMES_DIR, g.slug);
  const target = resolveGameFile(base, rel);
  if (!target) return res.status(400).json({ error: '非法路径' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: '请求体为空(请用 --data-binary @文件 上传原始字节)' });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, req.body);
  if (req.query.stage !== '1') {
    db.prepare("UPDATE games SET updated_at = datetime('now','localtime') WHERE id = ?").run(g.id);
  }
  res.json({ ok: true, path: rel, bytes: req.body.length, staged: req.query.stage === '1' });
});

app.delete('/api/games/:slug/files/*', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const rel = String(req.params[0] || '').replace(/^\/+/, '');
  const target = resolveGameFile(path.join(GAMES_DIR, g.slug), rel);
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

// ---------- API: 版本发布(暂存 → 原子激活)与回滚(P0) ----------
// 流程: 用 PUT ?stage=1 把文件上传到私密暂存目录(此时线上旧版不受影响)
//      → POST /activate 把旧版快照为 release 并原子切换新内容 → 旧版可随时回滚。
// 上传中断只影响暂存目录,线上旧版始终可玩。

app.get('/api/games/:slug/releases', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const rows = db.prepare(
    'SELECT id, version, note, size_bytes, created_at FROM releases WHERE game_id = ? ORDER BY id DESC'
  ).all(g.id).map((r) => {
    // 交付物信息:game-cli 构建产物是否存在
    const artDir = path.join(ARTIFACTS_DIR, g.slug, r.version);
    const artifacts = [];
    for (const f of ARTIFACT_ALLOW) {
      const p = path.join(artDir, f);
      if (fs.existsSync(p)) artifacts.push({ file: f, bytes: fs.statSync(p).size });
    }
    const snapDir = path.join(RELEASES_DIR, g.slug, String(r.id));
    return { ...r, artifacts, hasSnapshot: fs.existsSync(path.join(snapDir, 'index.html')) };
  });
  res.json({ releases: rows });
});

// 把当前线上内容固化为一个 release 快照(不切换内容,用于发布前打点)
app.post('/api/games/:slug/releases', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const liveDir = path.join(GAMES_DIR, g.slug);
  if (!fs.existsSync(liveDir)) return res.status(400).json({ error: '该游戏还没有任何文件' });
  const version = String(req.body?.version || '').trim() || `v${Date.now()}`;
  const note = String(req.body?.note || '').trim();
  const r = db.prepare('INSERT INTO releases (game_id, version, note, size_bytes) VALUES (?,?,?,?)')
    .run(g.id, version, note, dirBytes(liveDir));
  const dest = path.join(RELEASES_DIR, g.slug, String(r.lastInsertRowid));
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(liveDir, dest, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
  res.json({ ok: true, release: { id: r.lastInsertRowid, version, note } });
});

// 原子激活暂存内容:先把当前线上内容快照为 release,再整体切换到暂存内容
app.post('/api/games/:slug/activate', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const stagingDir = path.join(STAGING_DIR, g.slug);
  const liveDir = path.join(GAMES_DIR, g.slug);
  if (!fs.existsSync(path.join(stagingDir, 'index.html'))) {
    return res.status(400).json({ error: '暂存内容缺少 index.html,不能激活' });
  }
  const version = String(req.body?.version || '').trim() || `v${Date.now()}`;
  const note = String(req.body?.note || '').trim();

  // 1) 旧版有真实内容(非空)时快照为 release,供回滚
  //    注意 POST /api/games 会预建空目录,空目录不算旧版。
  let previousReleaseId = null;
  const liveHasContent = fs.existsSync(liveDir)
    && fs.readdirSync(liveDir, { withFileTypes: true }).some((e) => e.isDirectory() || !e.name.startsWith('.'));
  if (liveHasContent) {
    const r = db.prepare('INSERT INTO releases (game_id, version, note, size_bytes) VALUES (?,?,?,?)')
      .run(g.id, version, note, dirBytes(liveDir));
    previousReleaseId = r.lastInsertRowid;
    const dest = path.join(RELEASES_DIR, g.slug, String(previousReleaseId));
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(liveDir, dest, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
  }
  const newSize = dirBytes(stagingDir);

  // 2) 原子切换:删除旧 live → 把 staging 整体改名为 live
  try {
    if (fs.existsSync(liveDir)) fs.rmSync(liveDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(liveDir), { recursive: true });
    fs.renameSync(stagingDir, liveDir);
  } catch (e) {
    // 切换失败:尝试从快照恢复旧内容
    if (previousReleaseId) {
      const src = path.join(RELEASES_DIR, g.slug, String(previousReleaseId));
      if (fs.existsSync(src)) fs.cpSync(src, liveDir, { recursive: true });
    }
    return res.status(500).json({ error: '激活失败,已尝试恢复旧版本', detail: String(e.message) });
  }

  // 3) 总是为新版本记录 release 行(版本历史 + 交付物按版本追溯;内容即 live,无需快照)
  const nv = db.prepare('INSERT INTO releases (game_id, version, note, size_bytes) VALUES (?,?,?,?)')
    .run(g.id, version, note ? `activated: ${note}` : 'activated', newSize);
  db.prepare("UPDATE games SET updated_at = datetime('now','localtime') WHERE id = ?").run(g.id);
  res.json({ ok: true, version, releaseId: previousReleaseId, currentReleaseId: nv.lastInsertRowid, staged: false });
});

// 回滚到某个 release 快照
app.post('/api/games/:slug/rollback', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const releaseId = Number(req.body?.releaseId);
  if (!releaseId) return res.status(400).json({ error: '缺少 releaseId' });
  const rel = db.prepare('SELECT * FROM releases WHERE id = ? AND game_id = ?').get(releaseId, g.id);
  if (!rel) return res.status(404).json({ error: 'release 不存在' });
  const src = path.join(RELEASES_DIR, g.slug, String(rel.id));
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'release 文件缺失' });
  const liveDir = path.join(GAMES_DIR, g.slug);
  if (fs.existsSync(liveDir)) fs.rmSync(liveDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(liveDir), { recursive: true });
  fs.cpSync(src, liveDir, { recursive: true });
  db.prepare("UPDATE games SET updated_at = datetime('now','localtime') WHERE id = ?").run(g.id);
  res.json({ ok: true, restored: rel.version, releaseId: rel.id });
});

// ---------- P2: 版本/草稿预览(短时会话,修复多文件预览子资源 403)与交付物下载 ----------
// 预览会话:管理员创建 → 得到 /preview/<token>/ 公网路径(无需再带 ?token=),
// 子资源请求自然继承路径中的会话 token,多文件游戏也能完整预览。会话短时过期。
// 两种来源:release 快照(历史版本) 或 当前暂存目录(草稿预览,未上线)。

const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 分钟
const previewSessions = new Map(); // token -> { sourceDir, kind, expiresAt }
function issuePreviewSession(sourceDir, kind, label) {
  const token = crypto.randomBytes(16).toString('hex');
  previewSessions.set(token, { sourceDir, kind, label, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return token;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of previewSessions) if (v.expiresAt < now) previewSessions.delete(k);
}, 10 * 60 * 1000).unref?.();

// 历史版本预览(需要 release 快照)
app.post('/api/games/:slug/releases/:releaseId/preview-session', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const releaseId = Number(req.params.releaseId);
  const rel = db.prepare('SELECT * FROM releases WHERE id = ? AND game_id = ?').get(releaseId, g.id);
  if (!rel) return res.status(404).json({ error: 'release 不存在' });
  const src = path.join(RELEASES_DIR, g.slug, String(rel.id));
  if (!fs.existsSync(path.join(src, 'index.html'))) return res.status(404).json({ error: 'release 内容缺失' });
  const token = issuePreviewSession(src, 'release', `release#${rel.id}`);
  res.json({ ok: true, previewUrl: `/preview/${token}/`, expiresInMin: PREVIEW_TTL_MS / 60000, releaseId, version: rel.version });
});

// 草稿预览(当前暂存内容,未上线;上传中断/半成品不影响线上,可安全预览)
app.post('/api/games/:slug/preview-session', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const src = path.join(STAGING_DIR, g.slug);
  if (!fs.existsSync(path.join(src, 'index.html'))) return res.status(404).json({ error: '暂存内容为空(先用 --stage 上传)' });
  const token = issuePreviewSession(src, 'staging', `draft:${g.slug}`);
  res.json({ ok: true, previewUrl: `/preview/${token}/`, expiresInMin: PREVIEW_TTL_MS / 60000, kind: 'staging' });
});

// 预览静态服务(公网可访问但仅限短时有效会话)
app.use('/preview/:token', (req, res, next) => {
  const s = previewSessions.get(req.params.token);
  if (!s || s.expiresAt < Date.now()) return res.status(410).json({ error: 'preview 会话无效或已过期' });
  req.preview = s;
  next();
}, (req, res, next) => {
  express.static(req.preview.sourceDir, { index: 'index.html', extensions: ['html'], fallthrough: false })(req, res, next);
});

// 交付物下载(管理接口):web.zip / source.zip / validation-report.json / release.json / checksums.sha256
const ARTIFACT_ALLOW = new Set(['web.zip', 'source.zip', 'validation-report.json', 'release.json', 'checksums.sha256']);
app.get('/api/games/:slug/releases/:releaseId/artifacts/:file', adminAuth, (req, res) => {
  const g = db.prepare('SELECT id, slug FROM games WHERE slug = ?').get(req.params.slug);
  if (!g) return res.status(404).json({ error: '游戏不存在' });
  const releaseId = Number(req.params.releaseId);
  const rel = db.prepare('SELECT * FROM releases WHERE id = ? AND game_id = ?').get(releaseId, g.id);
  if (!rel) return res.status(404).json({ error: 'release 不存在' });
  const file = String(req.params.file || '');
  if (!ARTIFACT_ALLOW.has(file)) return res.status(400).json({ error: '不允许的交付物文件名' });
  const p = path.join(ARTIFACTS_DIR, g.slug, rel.version, file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: `交付物不存在: ${file}(需先用 game build/package 生成)` });
  res.download(p, `${g.slug}-${rel.version}-${file}`);
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
// 健康检查(公开,供 CI/CD 与监控探测)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    games: db.prepare('SELECT COUNT(*) c FROM games').get().c,
    liveGames: db.prepare('SELECT COUNT(*) c FROM games WHERE playable = 1').get().c,
  });
});

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
  console.log('     凭据见 config.json(adminToken / adminPass),建议用环境变量 GAME_STATION_TOKEN 传入:');
  console.log(`     GAME_STATION_TOKEN=<config.json 的 adminToken> node scripts/publish.mjs /path/to/game-dir --title "游戏名" --publish`);
  console.log('   🔑 后台登录账号见 config.json(adminUser / adminPass)。');
  console.log('==============================================');
});
