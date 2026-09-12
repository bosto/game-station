// SQLite 数据库:games / stats
// 本平台只做「发布 + 托管 + 试玩统计」,不再有流水线/想法池/微信项目等表。
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'station.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  source TEXT DEFAULT '',
  playable INTEGER DEFAULT 0,
  plays INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  plays INTEGER DEFAULT 0,
  UNIQUE(game_id, date)
);
`);

// ---- 旧版本(v0.1 流水线版)数据迁移 ----
// 旧 games 表多出 stage/status/idea_id/wechat_* 列,无害,保留数据;
// 补上新的 source 列;废弃的表直接删除。
const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
if (!cols.includes('source')) {
  db.exec("ALTER TABLE games ADD COLUMN source TEXT DEFAULT ''");
}
for (const t of ['ideas', 'decisions', 'wechat_projects', 'settings']) {
  db.exec(`DROP TABLE IF EXISTS ${t}`);
}

module.exports = db;
