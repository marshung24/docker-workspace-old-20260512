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

# 系統套件：基礎工具、網路診斷、Python 3、JDK 11/21、MySQL/Redis Client
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates gnupg sudo tzdata locales \
        curl wget git zip unzip jq less tree \
        bash bash-completion openssh-client \
        net-tools iputils-ping dnsutils iproute2 tcpdump \
        nano vim htop \
        graphviz \
        python3 python3-pip python3-venv python-is-python3 \
        openjdk-11-jdk openjdk-21-jdk \
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

# Node.js 22（NodeSource）+ 全域 npm 工具（OpenAI Codex CLI）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @openai/codex && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 全域 shell 體驗：綠色 PS1、常用 alias、啟用 bash-completion
RUN echo 'export PS1="\[\e[0;32m\]\u:\w\\$\[\e[0m\] "' >> /etc/bash.bashrc && \
    echo 'alias ll="ls -l"' >> /etc/bash.bashrc && \
    echo 'alias la="ls -la"' >> /etc/bash.bashrc && \
    echo 'if [ -f /usr/share/bash-completion/bash_completion ]; then' >> /etc/bash.bashrc && \
    echo '    . /usr/share/bash-completion/bash_completion' >> /etc/bash.bashrc && \
    echo 'fi' >> /etc/bash.bashrc

# 建立使用者 mars（附加群組 admin / sudouser / sudo，免密碼 sudo）
# DECISION: Ubuntu 24.04 基底映像內建 ubuntu 帳號佔用 UID/GID 1000，先移除以釋出
RUN userdel -r ubuntu 2>/dev/null || true && \
    groupdel ubuntu 2>/dev/null || true && \
    groupadd -g "${GID}" "${USERNAME}" && \
    groupadd -f admin && \
    groupadd -f sudouser && \
    useradd -m -u "${UID}" -g "${GID}" -G admin,sudouser,sudo -s /bin/bash "${USERNAME}" && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${USERNAME}" && \
    chmod 0440 "/etc/sudoers.d/90-${USERNAME}" && \
    # 工作目錄 /srv 交給 mars
    mkdir -p /srv && \
    chown "${UID}:${GID}" /srv

# 以 mars 身分安裝 AI Agent CLI（安裝腳本會裝到使用者家目錄）
USER ${USERNAME}
WORKDIR /home/${USERNAME}

# Claude Code（Anthropic）
RUN curl -fsSL https://claude.ai/install.sh | bash
# Antigravity CLI（Google）— 執行檔名為 agy，裝在 ~/.local/bin
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
# opencode
RUN curl -fsSL https://opencode.ai/install | bash

# 將各 CLI 的使用者層安裝路徑加入 PATH（非互動 shell 也吃得到）
ENV PATH="/home/${USERNAME}/.local/bin:/home/${USERNAME}/.opencode/bin:${PATH}"

WORKDIR /srv

CMD ["bash"]
