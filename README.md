# Docker 開發工作區

Ubuntu 24.04 LTS 開發容器，內建 AI Agent CLI 與多語言工具鏈。

## 內容物

| 類別 | 項目 |
|------|------|
| OS | Ubuntu 24.04 LTS（時區 Asia/Taipei） |
| 帳號 | `mars`（附加群組 `admin`、`sudouser`、`sudo`，免密碼 sudo） |
| 工作目錄 | `/srv`（bind mount 自 `./workspace/`） |
| AI CLI | Claude Code（`claude`）、Antigravity CLI（`agy`）、opencode、Codex（`codex`） |
| Runtime | Node.js 22、Python 3、JDK 11 / 21（預設 21） |
| 工具 | zip/unzip、curl/wget、git、mysql client、redis-tools、vim/nano、htop、tcpdump、graphviz 等 |

## 使用方式

```bash
# 只建置映像（不啟動容器）
docker compose build

# 建置並啟動（首次約需數分鐘下載）
docker compose up -d --build

# 進入容器
docker compose exec workspace bash

# 停止 / 移除
docker compose down
```

> Linux 宿主機請先把 `.env` 的 `UID`/`GID` 改成 `id -u` / `id -g` 的結果；macOS 維持預設即可。

## 持久化設計

掛載路徑以 `.env` 的 `PROJECT_ROOT` 為基準（預設 `.`＝本目錄，跨專案共用設定時可改為絕對路徑）。

| 容器路徑 | 掛載來源 | 用途 |
|----------|----------|------|
| `/srv` | named volume `workspace` | 專案程式碼（用 named volume 避開 macOS bind mount 對大量小檔的效能問題） |
| `/home/mars/.ssh` | `${PROJECT_ROOT}/configs/ssh/` | SSH 金鑰與設定 |
| `/home/mars/.gitconfig` | `${PROJECT_ROOT}/configs/gitconfig` | Git 設定 |
| `/home/mars/.claude.json` | `${PROJECT_ROOT}/configs/claude.json` | Claude Code 全域狀態 |
| `/home/mars/.claude` | `${PROJECT_ROOT}/.claude/` | Claude Code 設定與登入憑證 |
| `/home/mars/.codex` | `${PROJECT_ROOT}/.codex/` | Codex 設定與登入憑證 |
| `/home/mars/.gemini` | `${PROJECT_ROOT}/.gemini/` | Gemini/Antigravity 相關設定 |
| `/home/mars/.config` | `${PROJECT_ROOT}/.config/` | XDG 設定（opencode 等） |
| `/home/mars` | named volume `mars-home` | 其餘家目錄（opencode 資料、shell 歷史） |

各 AI CLI 首次使用需在容器內登入（`claude` / `codex` / `opencode auth login` 等），憑證會保留在上述掛載中，重建容器不需重新登入。

`configs/ssh/`、`configs/claude.json`、`.claude/`、`.codex/`、`.gemini/`、`.config/`、`workspace/` 內容已列入 `.gitignore`，不會進版控。

## AI CLI 安裝位置

| CLI | 入口指令 | 主程式本體 | 安裝形式 |
|-----|----------|-----------|----------|
| Claude Code | `~/.local/bin/claude`（symlink） | `~/.local/share/claude/versions/{版本}` | 單一原生執行檔（約 244MB），帶版本目錄；自動更新時下載新版後切換 symlink |
| Antigravity | `~/.local/bin/agy` | 同左（即執行檔本身） | 單一原生執行檔（約 158MB） |
| opencode | `~/.opencode/bin/opencode` | 同左（即執行檔本身） | 單一原生執行檔（約 180MB），裝在自家目錄 `~/.opencode/` |
| Codex | `/usr/bin/codex`（npm symlink） | `/usr/lib/node_modules/@openai/codex/` | npm 全域安裝（套件約 295MB），root 擁有 |

注意事項：

- Claude Code、agy、opencode 的主程式都在 `/home/mars` 內，落在 named volume `mars-home` 中：容器內自我更新（如 `claude update`）會持久化，重建容器不退版；`docker compose down -v` 清掉 volume 後回到映像建置當下的版本。
- `.claude/` bind mount 只含設定與憑證，不含主程式，宿主機端不會被大型執行檔佔據。
- Codex 是唯一裝在系統層的，mars 無法直接自我更新（需 `sudo npm update -g @openai/codex`），升版建議改 Dockerfile 重建映像。

## JDK 切換

預設 JDK 21（`JAVA_HOME=/usr/lib/jvm/default`）。需要 JDK 11 時：

```bash
sudo update-alternatives --config java
sudo update-alternatives --config javac
```

## 工作目錄存取

`/srv` 是 named volume，宿主機看不到內容，存取方式：

```bash
# 複製檔案 進/出 容器
docker compose cp ./some-file workspace:/srv/
docker compose cp workspace:/srv/some-project ./

# 或在容器內用 git 同步
docker compose exec workspace bash -c "cd /srv/some-project && git push"
```

## 注意事項

- **`docker compose down -v` 會連 `workspace` volume（`/srv` 的工作成果）一起刪除**，執行前務必先 push 或備份；只想重置家目錄時用 `docker volume rm docker-workspace_mars-home` 單獨刪。
- 重建映像（`--build`）不會清掉 named volume。
- 容器內連宿主機服務（MySQL/Redis 等）用 `host.docker.internal`。
