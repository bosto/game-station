#!/usr/bin/env node
// 一致性备份:SQLite(经 backup API,正确处理 WAL,不直接复制正在写入的 db)
//           + 游戏文件目录 + 配置(含凭据,备份目录权限收紧)。
// 用法: node scripts/backup.mjs [--dest <目录>]
//   默认备份到仓库外的 /Users/yes/games/game-station-backups/<时间戳>/,
//   避免备份被 git 提交或部署脚本同步。支持与 server 相同的环境变量覆盖。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const pick = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DATA_DIR = process.env.GAME_STATION_DATA_DIR || path.join(__dirname, '..', 'data');
const GAMES_DIR = process.env.GAME_STATION_GAMES_DIR || path.join(__dirname, '..', 'games');
const CONFIG_PATH = process.env.GAME_STATION_CONFIG || path.join(__dirname, '..', 'config.json');
const DB_PATH = path.join(DATA_DIR, 'station.db');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', 'game-station-backups');
const destRoot = pick('dest', DEFAULT_ROOT);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(destRoot, stamp);

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) fail(`找不到数据库: ${DB_PATH}`);

// 收紧权限,备份含凭据
fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
fs.chmodSync(dest, 0o700);

// 1) SQLite 一致性快照(WAL 安全)
const dbSnapPath = path.join(dest, 'station.db');
const db = new Database(DB_PATH, { readonly: true });
db.backup(dbSnapPath)
  .then(() => {
    db.close();
    const st = fs.statSync(dbSnapPath);
    console.log(`✓ 数据库快照: ${dbSnapPath} (${st.size} B)`);

    // 2) 游戏文件目录
    if (fs.existsSync(GAMES_DIR)) {
      const gamesDest = path.join(dest, 'games');
      fs.cpSync(GAMES_DIR, gamesDest, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith('.'),
      });
      console.log(`✓ 游戏文件: ${gamesDest}`);
    }

    // 3) 配置(含凭据,随备份保存以便恢复)
    if (fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(CONFIG_PATH, path.join(dest, 'config.json'));
      console.log(`✓ 配置: ${path.join(dest, 'config.json')}`);
    }

    console.log(`\n✅ 备份完成: ${dest}`);
  })
  .catch((e) => {
    db.close();
    fail('数据库备份失败: ' + e.message);
  });
