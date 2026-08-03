#!/bin/bash
# =============================================================================
# 容器啟動入口：修正 Docker socket 權限後執行主指令
# 使用案例：docker compose 啟動時自動調整 /var/run/docker.sock 權限，
#          讓 docker group 成員能操作宿主機 Docker
# =============================================================================

# 修正 Docker socket 權限
# DECISION: macOS Docker Desktop 掛入的 socket 為 root:root 0660，無法用
#           groupmod 對齊 GID（GID 0 已被 root group 佔用）；改用 chgrp 將
#           socket 的 group 改為容器內 docker group，再確保 group 可讀寫
if [ -S /var/run/docker.sock ]; then
    sudo chgrp docker /var/run/docker.sock
    sudo chmod g+rw /var/run/docker.sock
fi

# 註冊 Playwright MCP server（若尚未註冊）
# DECISION: 用 entrypoint 而非 Dockerfile RUN 註冊——`claude mcp add` 寫入的
#           ~/.claude.json 是 bind mount（configs/claude.json，個人狀態不入版控），
#           Dockerfile build time 寫入的內容會在容器啟動、bind mount 接管後被蓋掉。
#           entrypoint 在 mount 生效後才跑，寫入才會真正持久化。冪等：已註冊過就跳過，
#           失敗不擋容器啟動（|| true）。瀏覽器實體跑在 Host 端，見 tools/playwright/
if command -v claude >/dev/null 2>&1 && ! claude mcp get playwright >/dev/null 2>&1; then
    claude mcp add --scope user playwright -- npx -y @playwright/mcp@0.0.78 \
        --endpoint "${PLAYWRIGHT_WS_ENDPOINT:-ws://host.docker.internal:3910/playwright}" --isolated \
        >/dev/null 2>&1 || true
fi

# 執行原始指令（CMD 或 docker compose command）
exec "$@"
