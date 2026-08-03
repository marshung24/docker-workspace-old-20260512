# syntax=docker/dockerfile:1

# =============================================================================
# 開發工作用容器：Ubuntu 24.04 LTS + AI Agent CLI + 多語言工具鏈
# 使用案例：日常開發工作區（/srv），內建 Claude Code / Antigravity / opencode /
#          codex、Node.js 22、Python 3、JDK 11/21、MySQL/Redis Client
# =============================================================================
FROM ubuntu:24.04

# 建置參數：UID/GID 對齊宿主機使用者，避免 bind mount 權限問題（Linux 宿主機才需要調整）
ARG USERNAME=mars
ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Taipei \
    LANG=C.UTF-8

# 系統套件：基礎工具、網路診斷、Python 3、JDK 11/21、Maven、MySQL/Redis Client
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates gnupg sudo tzdata locales \
        curl wget git zip unzip jq less tree rsync \
        bash bash-completion openssh-client \
        net-tools iputils-ping dnsutils iproute2 tcpdump \
        nano vim htop \
        graphviz \
        inotify-tools \
        direnv \
        python3 python3-pip python3-venv python-is-python3 \
        openjdk-11-jdk openjdk-21-jdk maven \
        mysql-client redis-tools && \
    # 設定台北時區
    ln -sf /usr/share/zoneinfo/Asia/Taipei /etc/localtime && \
    echo "Asia/Taipei" > /etc/timezone && \
    # 清理快取
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# JAVA_HOME 指向預設 JDK
# DECISION: 同裝 JDK 11/21，預設走 21（update-alternatives 優先權較高）；
#           需要 JDK 11 時用 `sudo update-alternatives --config java` 切換
RUN ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")" /usr/lib/jvm/default
ENV JAVA_HOME=/usr/lib/jvm/default

# Node.js 22（NodeSource）+ 全域 npm 工具（Yarn、OpenAI Codex CLI）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g yarn @openai/codex && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Playwright client library（僅 client，不含 browser binary）
# DECISION: 瀏覽器實體跑在 macOS Host 端（見 tools/playwright/browser-host.js），容器內
#           AI Agent 透過 PLAYWRIGHT_WS_ENDPOINT（host.docker.internal）遠端操控——好處是
#           工程師可直接在 Host 觀察/接手 headed browser，也省下容器內裝 Chromium 的體積
#           （PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 跳過 postinstall 下載，省 ~400-900MB）。
#           版本需與 tools/playwright/package.json 一致（SSOT），升級時兩處同步改
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g playwright@${PLAYWRIGHT_VERSION}

# Docker CLI（僅客戶端，不含 daemon）— 透過掛載 docker.sock 操作宿主機 Docker
# DECISION: 只裝 docker-ce-cli + docker-compose-plugin，不裝 docker-ce（容器內不跑 daemon）
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
      https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI（gh）— 官方 apt 來源，供操作 GitHub PR/Issue 等
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# GitLab CLI（glab）— GitLab 未提供官方 apt repo，改抓固定版本的 Release .deb 安裝
# DECISION: 版本號寫死（非動態解析 permalink/latest 重導向）並比對官方 checksums.txt——
#           原本用重導向解析最新版號的寫法沒有 pin 版本也沒驗證完整性，建置不可重現，
#           GitLab 改頁面結構或 asset 命名就會裝失敗；升版時手動更新 GLAB_VERSION 即可
ARG GLAB_VERSION=1.111.0
RUN ARCH=$(dpkg --print-architecture) && \
    GLAB_DEB="glab_${GLAB_VERSION}_linux_${ARCH}.deb" && \
    GLAB_BASE_URL="https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads" && \
    curl -fsSL -o "/tmp/${GLAB_DEB}" "${GLAB_BASE_URL}/${GLAB_DEB}" && \
    curl -fsSL -o /tmp/glab_checksums.txt "${GLAB_BASE_URL}/checksums.txt" && \
    (cd /tmp && grep " ${GLAB_DEB}\$" glab_checksums.txt | sha256sum -c -) && \
    apt-get update && \
    apt-get install -y --no-install-recommends "/tmp/${GLAB_DEB}" && \
    rm -f "/tmp/${GLAB_DEB}" /tmp/glab_checksums.txt && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# code-server（瀏覽器版 VS Code）— 官方安裝腳本，裝到系統路徑 /usr/bin/code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh && \
    rm -rf /var/lib/apt/lists/* ~/.cache

# 全域 shell 體驗：綠色 PS1、常用 alias、啟用 bash-completion、direnv hook
# direnv hook 要掛在互動 shell 才會生效（cd 進目錄時自動 load/unload .envrc），
# 非互動 shell（如 RUN、entrypoint exec）不受影響
RUN echo 'export PS1="\[\e[0;32m\]\u:\w\\$\[\e[0m\] "' >> /etc/bash.bashrc && \
    echo 'alias ll="ls -l"' >> /etc/bash.bashrc && \
    echo 'alias la="ls -la"' >> /etc/bash.bashrc && \
    echo 'if [ -f /usr/share/bash-completion/bash_completion ]; then' >> /etc/bash.bashrc && \
    echo '    . /usr/share/bash-completion/bash_completion' >> /etc/bash.bashrc && \
    echo 'fi' >> /etc/bash.bashrc && \
    echo 'eval "$(direnv hook bash)"' >> /etc/bash.bashrc

# 建立使用者 mars（附加群組 admin / sudouser / sudo，免密碼 sudo）
# DECISION: Ubuntu 24.04 基底映像內建 ubuntu 帳號佔用 UID/GID 1000，先移除以釋出
RUN userdel -r ubuntu 2>/dev/null || true && \
    groupdel ubuntu 2>/dev/null || true && \
    groupadd -g "${GID}" "${USERNAME}" && \
    groupadd -f admin && \
    groupadd -f sudouser && \
    groupadd -f docker && \
    useradd -m -u "${UID}" -g "${GID}" -G admin,sudouser,sudo,docker -s /bin/bash "${USERNAME}" && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${USERNAME}" && \
    chmod 0440 "/etc/sudoers.d/90-${USERNAME}" && \
    # 工作目錄 /srv 交給 mars
    mkdir -p /srv && \
    chown "${UID}:${GID}" /srv

# 容器啟動入口：修正 Docker socket 權限等初始化動作
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]

# 以 mars 身分安裝 AI Agent CLI（安裝腳本會裝到使用者家目錄）
USER ${USERNAME}
WORKDIR /home/${USERNAME}

# Claude Code（Anthropic）
RUN curl -fsSL https://claude.ai/install.sh | bash
# Antigravity CLI（Google）— 執行檔名為 agy，裝在 ~/.local/bin
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
# opencode
RUN curl -fsSL https://opencode.ai/install | bash
# bun — 不是給使用者直接用的 CLI，是 Claude Code telegram plugin 的 MCP server 執行環境
# （plugin 內部用 `bun run` 啟動，缺這個 telegram MCP 會顯示 ENOENT: bun not found）
RUN curl -fsSL https://bun.sh/install | bash
# uv — tools/setting/dw（Python CLI，取代 Make）的 shebang 用 `uv run --script`
# 依 PEP 723 inline metadata 自動建 venv、裝相依套件，不用手動 pip install
RUN curl -fsSL https://astral.sh/uv/install.sh | sh

# 將各 CLI 的使用者層安裝路徑加入 PATH（非互動 shell 也吃得到）
ENV PATH="/home/${USERNAME}/.local/bin:/home/${USERNAME}/.opencode/bin:/home/${USERNAME}/.bun/bin:${PATH}"

WORKDIR /srv

CMD ["bash"]
