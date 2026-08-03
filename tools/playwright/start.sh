#!/usr/bin/env bash
# =================================================================
# Playwright Browser Host — 啟動腳本
# =================================================================
# 用途：背景啟動 browser-host.js（Lazy Launch），
#       驗證 TCP Server 是否成功 bind port。
#
# 使用方式：bash tools/playwright/start.sh
#
# 流程：
#   1. 檢查是否已在執行（PID 檔 + kill -0）
#   2. nohup 背景啟動 browser-host.js
#   3. 等待 2 秒，確認 process 存活 + log 無錯誤
#   4. 成功時印啟動資訊
# =================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.browser-host.pid"
LOG_FILE="$SCRIPT_DIR/browser-host.log"
PORT=${PLAYWRIGHT_HOST_PORT:-3910}

# -- Step 1: 檢查是否已在執行 --
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Browser Host 已在執行中 (PID: $(cat "$PID_FILE"))"
  exit 0
fi

# -- Step 2: 背景啟動 --
cd "$SCRIPT_DIR"
nohup node browser-host.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# -- Step 3: 等待並驗證 --
sleep 2

PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  # process 已死：啟動失敗
  echo "Browser Host 啟動失敗，查看 log："
  cat "$LOG_FILE"
  if grep -qi 'EADDRINUSE' "$LOG_FILE" 2>/dev/null; then
    echo ""
    echo "→ 可能原因: port $PORT 已被佔用"
    echo "  lsof -i :$PORT 可查看佔用 port 的 process"
  fi
  rm -f "$PID_FILE"
  exit 1
fi

# process 活著，檢查 log 是否有錯誤（如 EADDRINUSE）
if grep -qi 'error\|EADDRINUSE' "$LOG_FILE" 2>/dev/null; then
  echo "Browser Host 啟動異常 (PID: $PID)，log 含錯誤訊息："
  cat "$LOG_FILE"
  echo ""
  echo "→ 可能原因: port $PORT 已被佔用，請先 bash tools/playwright/stop.sh 或手動清理"
  rm -f "$PID_FILE"
  exit 1
fi

# -- Step 4: 成功 --
echo "Browser Host 已啟動 (PID: $PID)"
cat "$LOG_FILE"
echo ""
echo "首次連線時 Chromium 才會啟動（lazy mode）"
