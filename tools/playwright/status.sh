#!/usr/bin/env bash
# =================================================================
# Playwright Browser Host — 狀態查詢腳本
# =================================================================
# 用途：檢查 PID 檔是否存在且 process 是否活著（不代表 Chromium 正在
#       執行——lazy mode 下沒有連線時 Chromium 本來就是關閉的）
#
# 使用方式：bash tools/playwright/status.sh
# =================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.browser-host.pid"
PORT=${PLAYWRIGHT_HOST_PORT:-3910}

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Browser Host 執行中 (PID: $(cat "$PID_FILE"), lazy mode)"
  echo "  Endpoint: ws://host.docker.internal:${PORT}/playwright"
else
  echo "Browser Host 未執行"
  echo "  啟動：bash tools/playwright/start.sh"
fi
