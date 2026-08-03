#!/usr/bin/env bash
# ============================================================
# setup.sh — 跨平台 Playwright 安裝腳本
# ============================================================
# 用途：在 Host 端安裝 Playwright npm 套件與 Chromium browser
#       自動偵測平台（macOS / Linux / WSL2）並執行對應安裝流程
#
# 使用方式：bash tools/playwright/setup.sh
#
# 安裝內容：
#   - npm install（安裝 package.json 中的 playwright 套件）
#   - npx playwright install chromium（下載 Chromium browser binary ~400MB）
#   - Linux 額外安裝系統依賴（--with-deps：libX11 等 shared libraries）
#
# 前置條件：Node.js >= 18
# ============================================================
set -euo pipefail

# 取得腳本所在目錄，切換到 tools/playwright/ 作為工作目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -- 前置檢查：Node.js 是否安裝 --
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js 未安裝，請先安裝 Node.js >= 18"
  exit 1
fi

# -- 前置檢查：Node.js 版本 >= 18 --
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required (current: $(node -v))"
  exit 1
fi

# -- 偵測平台並執行對應安裝 --
OS="$(uname -s)"
case "$OS" in
  Darwin)
    # macOS：直接安裝，headed 模式原生支援
    # host.docker.internal 為 Docker Desktop 內建，無需額外設定
    echo "[macOS] 安裝 Playwright + Chromium..."
    npm install
    npx playwright install chromium
    ;;
  Linux)
    # Linux：需額外安裝 Chromium 的系統依賴（libX11、libglib 等）
    # --with-deps 會自動用 apt/yum 安裝所需的 shared libraries
    echo "[Linux] 安裝 Playwright + Chromium + 系統依賴..."
    npm install
    npx playwright install --with-deps chromium
    # WSL2 偵測：/proc/version 含 "microsoft" 字串
    # headed 模式需要 X Server（如 VcXsrv）轉發顯示
    if grep -qi microsoft /proc/version 2>/dev/null; then
      echo ""
      echo "[WSL2 注意] 若需 headed 模式，請確認已安裝 X Server（如 VcXsrv）"
      echo "  並設定 export DISPLAY=:0"
    fi
    ;;
  *)
    # 不支援的平台（Windows native 等）
    echo "ERROR: 不支援的平台 $OS"
    exit 1
    ;;
esac

# -- 安裝完成提示 --
echo ""
echo "安裝完成！啟動方式："
echo "  bash tools/playwright/start.sh"
