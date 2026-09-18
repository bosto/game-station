#!/usr/bin/env bash
# game-station 自动部署脚本(由 GitHub Actions 在本机 macos-local runner 上调用)
# 作用:把检查通过的新代码同步到运行目录 → 安装依赖 → 重启 launchd 服务 → 本地健康检查
set -euo pipefail

SRC="${GITHUB_WORKSPACE:?需要 GITHUB_WORKSPACE}"
DST="/Users/yes/games/game-station"
SERVICE="com.yes.game-station"

echo "==> 同步代码到 ${DST}"
# 第一遍:同步全部代码,排除运行数据/密钥/依赖/备份/构建产物
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.npm-cache' \
  --exclude 'data' \
  --exclude 'config.json' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude '*.bak-*' \
  --exclude 'games' \
  --exclude 'artifacts' \
  "${SRC}/" "${DST}/"
# 第二遍:games 只增不删 —— 保留本地通过平台发布但尚未提交到 git 的游戏
rsync -a --exclude '.DS_Store' "${SRC}/games/" "${DST}/games/"

echo "==> 安装依赖"
cd "${DST}"
npm ci --no-audit --no-fund --prefer-offline

echo "==> 语法检查"
node --check server.js

echo "==> 重启服务 ${SERVICE}"
launchctl kickstart -k "gui/$(id -u)/${SERVICE}"

echo "==> 等待本地服务就绪"
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/api/health 2>/dev/null || true)
  if [ "${code}" = "200" ]; then
    echo "✅ 本地服务健康(第 ${i} 次探测)"
    exit 0
  fi
  sleep 2
done
echo "❌ 本地服务未就绪" >&2
exit 1
