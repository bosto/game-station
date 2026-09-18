#!/usr/bin/env bash
# CI 冒烟测试(CI / 部署工作流共用):
#   在临时端口上、用完全隔离的临时 data/games/config 目录启动一个独立实例
#   → 跑完整发布流程冒烟测试 → 清理。绝不碰线上实例(默认 3211,与线上 3210 隔离),
#   也绝不修改当前工作区的 config.json / data / games。
#
# 用法: bash scripts/ci-smoke.sh [--port 3211] [--token ci-token]
set -euo pipefail

PORT=3211
TOKEN=ci-token

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# 1) 清理可能残留的旧监听进程:
#    若上一次 run 被取消(cancel / 机器重启)而未执行 trap 清理,3211 上可能挂着
#    旧代码的服务;不杀掉的话本轮冒烟会测到旧代码,造成假绿。
OLD_PIDS=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "==> 清理 ${PORT} 端口残留进程: ${OLD_PIDS}"
  echo "$OLD_PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 2) 生成隔离运行环境:临时目录里的 config/data/games,不覆盖工作区任何文件
CI_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gs-ci.XXXXXX")"
export GAME_STATION_CONFIG="${CI_DIR}/config.json"
export GAME_STATION_DATA_DIR="${CI_DIR}/data"
export GAME_STATION_GAMES_DIR="${CI_DIR}/games"
export GAME_STATION_STAGING_DIR="${CI_DIR}/staging"
export GAME_STATION_RELEASES_DIR="${CI_DIR}/releases"
cat > "${CI_DIR}/config.json" <<EOF
{
  "host": "127.0.0.1",
  "port": ${PORT},
  "publicHost": false,
  "adminUser": "admin",
  "adminPass": "ci-pass-123",
  "adminToken": "${TOKEN}"
}
EOF

# 3) 启动独立实例(写入隔离目录,日志也在隔离目录)
node server.js > "${CI_DIR}/ci-smoke.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$CI_DIR"
}
trap cleanup EXIT

# 4) 等待就绪
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break
  sleep 1
done

# 5) 跑发布流程冒烟测试
node scripts/smoke.mjs --url "http://127.0.0.1:${PORT}" --token "${TOKEN}"
