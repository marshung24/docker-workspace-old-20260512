#!/usr/bin/env bash
# =================================================================
# Playwright Browser Host — 停止腳本
# =================================================================
# 用途：發送 SIGTERM 給 browser-host.js 並等待 process 真正退出，
#       確保 TCP port 釋放後再回報成功。
#
# 使用方式：bash tools/playwright/stop.sh
#
# 等待策略：
#   browser-host.js shutdown handler 最多需 3 秒（forceExit），
#   本腳本等最多 5 秒，給足緩衝。正常 idle 狀態下 < 1 秒完成。
# =================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.browser-host.pid"

# -- 檢查 PID 檔 --
if [ ! -f "$PID_FILE" ]; then
  echo "Browser Host 未執行"
  exit 0
fi

PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
  # PID 檔存在但 process 已死
  rm -f "$PID_FILE"
  echo "Browser Host 未執行（已清理過期 PID 檔）"
  exit 0
fi

# -- 發送 SIGTERM --
kill "$PID" 2>/dev/null || true

# -- 等待 process 退出（最多 5 秒）--
for i in 1 2 3 4 5; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

# -- 確認是否真正退出 --
if kill -0 "$PID" 2>/dev/null; then
  echo "Browser Host 停止超時 (PID: $PID)，可能需手動 kill"
  echo "  → PID 檔已保留，請排查後再 bash tools/playwright/stop.sh"
  exit 1
else
  rm -f "$PID_FILE"
  echo "Browser Host 已停止"
fi
