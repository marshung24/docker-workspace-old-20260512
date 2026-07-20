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

# 執行原始指令（CMD 或 docker compose command）
exec "$@"
