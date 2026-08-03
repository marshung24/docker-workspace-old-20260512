// ============================================================
// browser-host.js — Playwright Browser Host Service (Lazy Launch)
// ============================================================
// 用途：在 Host 端提供 WebSocket endpoint，按需啟動 Chromium browser，
//       閒置自動關閉，供 Docker 容器（workspace / code-server）內的
//       AI Agent 遠端操控。
//
// 架構：
//   Client → TCP Server (port 3910, 常駐) → Playwright Server (動態 port, 按需啟動)
//
//   - Node process 啟動時只開 TCP server 監聽，不啟動 Chromium
//   - 第一個連線進來 → 啟動 Chromium → 轉發連線
//   - 最後一個連線斷開 → idle 倒數 → 關閉 Chromium（需 AI Agent 關掉 MCP session，
//     通常是退出 AI Agent 或下指令 close）
//   - 對外 endpoint 不變：ws://host.docker.internal:3910/playwright
//
// 好處：
//   - 沒在用時沒有 Chromium process → 不佔資源、不顯示 Dock icon
//   - macOS 關機時若 Chromium 未啟動 → 不會卡住
//   - 對外 endpoint 不變，client 無感
//
// 啟動方式：bash tools/playwright/start.sh
// 停止方式：bash tools/playwright/stop.sh
// ============================================================

import { chromium } from 'playwright';
import net from 'net';
import { execSync, execFileSync } from 'child_process';

// -- 環境變數設定 --
// PLAYWRIGHT_HOST_PORT: 對外監聽 port（預設 3910）
const PORT = parseInt(process.env.PLAYWRIGHT_HOST_PORT || '3910', 10);
// PLAYWRIGHT_HOST_HEADED: 1 = headed（顯示視窗，預設）, 0 = headless（無視窗）
const HEADLESS = process.env.PLAYWRIGHT_HOST_HEADED === '0';
// PLAYWRIGHT_IDLE_TIMEOUT: 閒置幾秒後關閉 Chromium（預設 5）
const IDLE_TIMEOUT = parseInt(process.env.PLAYWRIGHT_IDLE_TIMEOUT || '5', 10);
// 內部 port：Playwright server 實際 bind 的 port，由 OS 動態分配（避免固定 port 衝突）
let internalPort = 0;
// 唯一識別標記：透過 Chrome arg 注入，供 forceExit 時精準 pkill 本實例的 Chromium
// 使用 Node PID 確保每個 browser-host 實例的 marker 互不衝突
const BROWSER_HOST_MARKER = `--browser-host-id=${process.pid}`;

// -- State Machine --
// idle:     純監聽，無 Chromium process
// starting: 正在啟動 Chromium，新連線排隊等待
// running:  Chromium 運行中，正常轉發連線
// stopping: 正在關閉 Chromium，新連線排隊等，回到 idle 後重新啟動
let state = 'idle';

// -- 連線追蹤 --
// Playwright server instance（running 狀態下存在）
let playwrightServer = null;
// Chromium 主 process 的 PID（用於強制清理）
let chromiumPID = null;
// 當前活躍的 TCP 連線數
let activeConnections = 0;
// 閒置倒數 timer
let idleTimer = null;
// 等待 Chromium 啟動的 pending socket 佇列
let pendingSockets = [];
// launchServer 的 promise（用於 shutdown 時等待啟動完成再清理，防止 orphan process）
let launchPromise = null;

// -- 啟動失敗 cooldown --
// 連續失敗次數
let consecutiveFailures = 0;
// 最大連續失敗次數，超過後停止重試
const MAX_CONSECUTIVE_FAILURES = 3;
// cooldown 中（失敗後暫停接受新啟動請求）
let cooldownTimer = null;
// cooldown 時間（秒）
const COOLDOWN_SECONDS = 5;

/**
 * 強制終止指定 PID 及其所有子 process
 *
 * 用途：Playwright 啟動的 Chromium 跑在獨立 process group，
 *       Node process 結束時不會被連帶收掉。
 *       此函式精準砍 Playwright 開的 Chromium tree，不影響使用者自己的 Chrome。
 *
 * @param {number} pid - Chromium 主 process 的 PID
 */
function killProcessTree(pid) {
  if (!pid) return;
  try {
    // 先砍所有子 process（Helper、GPU、Renderer 等）
    execFileSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' });
  } catch {
    // 子 process 已不存在，忽略
  }
  try {
    // 再砍 Chromium 主 process
    process.kill(pid, 'SIGKILL');
  } catch {
    // 主 process 已不存在，忽略
  }
}

/**
 * 強制清理本實例啟動的 Chromium process（PID 未知時的 fallback）
 *
 * 用途：當 SIGTERM 在 starting 階段到達時，chromiumPID 尚未設定，
 *       無法用 killProcessTree() 清理。此函式透過 launchServer args 中
 *       注入的 BROWSER_HOST_MARKER（含本 Node PID）精準搜尋並終止。
 *
 * 安全性：只匹配帶有本實例 marker 的 Chromium，不影響同機其他
 *         Playwright 使用情境（如 @playwright/mcp、debug session 等）。
 */
function killPlaywrightChromiumByMarker() {
  try {
    // '--' 標記 end-of-options（POSIX 標準），防止 BROWSER_HOST_MARKER 的 '--' 前綴
    // 被 pkill 當成 option 解析（會導致 "illegal option" 錯誤而完全不搜尋）
    execFileSync('pkill', ['-KILL', '-f', '--', BROWSER_HOST_MARKER], { stdio: 'ignore' });
  } catch {
    // 沒有匹配的 process，忽略
  }
}

/**
 * 自動偵測 Docker bridge 網路的 gateway IP
 *
 * @returns {string|null} gateway IP（如 '172.17.0.1'），偵測失敗回 null
 */
function detectDockerGateway() {
  try {
    return execSync(
      "docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'",
      { encoding: 'utf8', timeout: 5000 }
    ).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 啟動 Chromium（state: idle → starting → running）
 *
 * 流程：
 *   1. 切換狀態為 starting
 *   2. 啟動 Playwright server（bind 127.0.0.1，內部 port）
 *   3. 記錄 Chromium PID
 *   4. 切換狀態為 running
 *   5. 清空 pending 佇列，逐一轉發
 *
 * 錯誤處理：啟動失敗 → 關閉 pending sockets → 回到 idle
 */
async function startChromium() {
  // cooldown 期間或已達失敗上限，拒絕啟動
  if (cooldownTimer || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const reason = cooldownTimer ? 'cooldown 中' : `連續失敗 ${consecutiveFailures} 次，已停止重試`;
    console.log(`[SKIP] Chromium 啟動被跳過（${reason}）`);
    const sockets = pendingSockets;
    pendingSockets = [];
    for (const socket of sockets) socket.destroy();
    return;
  }

  state = 'starting';
  console.log('Starting Chromium...');

  try {
    // 保存 launch promise，讓 shutdown 可等待啟動完成後再清理
    // 防止 SIGTERM during starting 產生 orphan Chromium process
    // port: 0 讓 OS 自動分配可用 port，避免固定 port 被其他服務佔用
    launchPromise = chromium.launchServer({
      headless: HEADLESS,
      port: 0,
      host: '127.0.0.1',
      wsPath: '/playwright',
      args: ['--start-maximized', BROWSER_HOST_MARKER],
    });

    // 啟動 Playwright server，bind OS 分配的 port
    // 外部 client 透過 TCP proxy 連到這裡
    playwrightServer = await launchPromise;
    launchPromise = null;

    // 從 wsEndpoint 解析實際分配的 port（格式：ws://127.0.0.1:XXXXX/playwright）
    const wsUrl = new URL(playwrightServer.wsEndpoint());
    internalPort = parseInt(wsUrl.port, 10);

    // 記錄 Chromium PID，用於 shutdown 時強制清理
    chromiumPID = playwrightServer.process().pid;

    // 監聽 Chromium 被外部終止（如 Activity Monitor 強制結束）
    playwrightServer.on('close', () => {
      if (state === 'running') {
        console.log('Chromium was terminated externally');
        playwrightServer = null;
        chromiumPID = null;
        activeConnections = 0;
        state = 'idle';
      }
    });

    // 啟動成功，重置失敗計數
    consecutiveFailures = 0;
    state = 'running';
    console.log(`Chromium started (PID: ${chromiumPID}, internal port: ${internalPort}, mode: ${HEADLESS ? 'headless' : 'headed'})`);

    // 清空 pending 佇列，轉發等待中的連線
    const sockets = pendingSockets;
    pendingSockets = [];
    for (const socket of sockets) {
      // pending 期間 client 可能已斷線，檢查 socket 是否還活著
      if (!socket.destroyed) {
        forwardSocket(socket);
      }
    }
  } catch (err) {
    launchPromise = null;

    // 累計失敗次數
    consecutiveFailures++;

    // 啟動失敗：關閉所有 pending sockets，回到 idle
    // 附帶可能原因，方便診斷（port 衝突、記憶體不足等）
    console.error(`[FATAL] Chromium 啟動失敗 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
    if (err.message.includes('EADDRINUSE')) {
      console.error('  → 可能原因: Playwright 內部 port 被其他服務佔用');
    }
    // Linux/WSL2 無 display server 時 headed 模式會失敗
    if (!HEADLESS && (err.message.includes('display') || err.message.includes('DISPLAY'))) {
      console.error('  → 可能原因: 無 display server，請設定 PLAYWRIGHT_HOST_HEADED=0 使用 headless 模式');
    }
    const sockets = pendingSockets;
    pendingSockets = [];
    for (const socket of sockets) {
      socket.destroy();
    }
    playwrightServer = null;
    chromiumPID = null;
    internalPort = 0;
    state = 'idle';

    // 啟動 cooldown，避免快速失敗循環（CPU spin）
    if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      console.log(`  → ${COOLDOWN_SECONDS}s cooldown 後才接受下次啟動`);
      cooldownTimer = setTimeout(() => { cooldownTimer = null; }, COOLDOWN_SECONDS * 1000);
    } else {
      console.error(`  → 已達最大重試次數，不再自動啟動。請排查問題後執行 bash tools/playwright/stop.sh && bash tools/playwright/start.sh`);
    }
  }
}

/**
 * 關閉 Chromium（state: running → stopping → idle）
 *
 * 流程：
 *   1. 切換狀態為 stopping
 *   2. 關閉 Playwright server（帶 3 秒 timeout 防卡死）
 *   3. 強制清理 Chromium process tree
 *   4. 切換狀態為 idle
 *   5. 若 stopping 期間有新連線排隊，重新啟動
 */
async function stopChromium() {
  if (state !== 'running' || !playwrightServer) return;

  // 防止 idle timer callback 與新連線的 race condition：
  // timer fired 後 callback 被排入 event loop，但在同一輪中新連線可能先被處理，
  // 導致 activeConnections > 0。此時不應關閉 Chromium，否則會打斷剛建立的連線。
  if (activeConnections > 0) return;

  state = 'stopping';
  console.log('Stopping Chromium (idle timeout)...');

  // 3 秒 timeout 防止 server.close() 卡死
  const savedPID = chromiumPID;
  const closePromise = playwrightServer.close().catch(() => {});
  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
  await Promise.race([closePromise, timeoutPromise]);

  // 確保 Chromium process tree 已清理
  killProcessTree(savedPID);

  playwrightServer = null;
  chromiumPID = null;
  internalPort = 0;
  activeConnections = 0;
  state = 'idle';
  console.log('Chromium stopped');

  // stopping 期間若有新連線排隊，過濾已斷線的 socket 後重新啟動
  pendingSockets = pendingSockets.filter(s => !s.destroyed);
  if (pendingSockets.length > 0) {
    startChromium();
  }
}

/**
 * 將 client socket 轉發到 Playwright server
 *
 * 建立雙向 pipe：client ↔ TCP proxy ↔ Playwright server
 * 追蹤連線數，最後一個斷線後啟動 idle 倒數
 *
 * @param {net.Socket} socket - client 端的 TCP socket
 */
function forwardSocket(socket) {
  // 建立到 Playwright server 的上游連線
  const upstream = net.connect(internalPort, '127.0.0.1');

  // error handler 必須在 pipe 之前註冊
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());

  // 雙向 pipe
  socket.pipe(upstream).pipe(socket);

  // 追蹤連線數
  activeConnections++;
  // 有新連線進來，取消閒置倒數
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // 連線關閉時更新計數，啟動閒置倒數
  const onClose = () => {
    activeConnections--;
    if (activeConnections <= 0 && state === 'running') {
      activeConnections = 0;
      console.log(`All connections closed, idle shutdown in ${IDLE_TIMEOUT}s...`);
      // 用 timer reference 作為 generation token：
      // 若舊 timer 已 fired（callback 已排入 event loop）但尚未執行，
      // 期間新連線進出又設了新 timer，舊 callback 會因 idleTimer !== thisTimer 而作廢，
      // 確保閒置倒數從「最後一次斷線」起算，不會被舊 timer 提早觸發
      const thisTimer = setTimeout(() => {
        if (idleTimer === thisTimer) stopChromium();
      }, IDLE_TIMEOUT * 1000);
      idleTimer = thisTimer;
    }
  };
  socket.on('close', onClose);
}

/**
 * 處理新進的 TCP 連線
 *
 * 根據 state machine 決定行為：
 *   - idle:     排隊 + 啟動 Chromium
 *   - starting: 排隊等待
 *   - running:  直接轉發
 *   - stopping: 排隊等待（Chromium 關完後會自動重啟）
 *
 * @param {net.Socket} socket - 新進的 TCP socket
 */
function handleConnection(socket) {
  if (state === 'running') {
    // Chromium 運行中，直接轉發
    forwardSocket(socket);
  } else if (state === 'idle') {
    // 純監聽狀態，排隊後啟動 Chromium
    pendingSockets.push(socket);
    socket.on('error', () => {}); // 避免 pending 期間 error 炸掉
    startChromium();
  } else if (state === 'starting' || state === 'stopping') {
    // 啟動中或關閉中，排隊等待
    pendingSockets.push(socket);
    socket.on('error', () => {}); // 避免 pending 期間 error 炸掉
  }
}

/**
 * 主程式：啟動 TCP Server（常駐）+ 註冊 shutdown handler
 *
 * 流程：
 *   1. 建立 TCP server 監聽對外 port（不啟動 Chromium）
 *   2. 偵測 Docker gateway IP，嘗試額外 bind（Linux 用）
 *   3. 註冊 SIGINT/SIGTERM/SIGHUP handler
 */
async function main() {
  // Step 1: 建立 TCP server，所有連線都經過 handleConnection 路由
  const tcpServer = net.createServer(handleConnection);

  tcpServer.listen(PORT, '127.0.0.1', () => {
    console.log('Playwright Browser Host started (lazy mode)');
    console.log(`  Endpoint:  ws://127.0.0.1:${PORT}/playwright`);
    console.log(`  Docker:    ws://host.docker.internal:${PORT}/playwright`);
    console.log(`  Mode:      ${HEADLESS ? 'headless' : 'headed'}`);
    console.log(`  Idle timeout: ${IDLE_TIMEOUT}s`);
    console.log('  Chromium:  not started (waiting for first connection)');
  });

  // Step 2: Docker gateway proxy（Linux 用）
  // macOS Docker Desktop 靠 host.docker.internal 自動轉發，不需要
  let gwServer = null;
  const gateway = detectDockerGateway();
  if (gateway) {
    gwServer = net.createServer(handleConnection);
    gwServer.on('error', (err) => {
      if (err.code === 'EADDRNOTAVAIL') {
        // macOS 預期行為，安靜跳過
        console.log(`  GW Proxy:  skipped (${gateway} not available on this host)`);
      } else {
        console.error(`  GW Proxy error: ${err.message}`);
      }
    });
    gwServer.listen(PORT, gateway, () => {
      console.log(`  GW Proxy:  ${gateway}:${PORT}`);
    });
  }

  // Step 3: 優雅關閉
  // 收到 SIGINT/SIGTERM/SIGHUP 時，關閉 TCP server + Chromium
  let shuttingDown = false;
  const shutdown = async (source) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutting down... (${source})`);

    // 3 秒強制結束的安全網
    // 注意：若 SIGTERM 在 starting 階段到達，chromiumPID 可能仍為 null
    // （launchServer cold start 需 2~5 秒，可能超過此 3 秒 timeout）
    // 此時用 killPlaywrightChromiumByMarker() 以注入的 marker arg 精準清理本實例的 Chromium
    const forceExit = setTimeout(() => {
      console.log('Force exit triggered');
      if (chromiumPID) {
        killProcessTree(chromiumPID);
      } else {
        killPlaywrightChromiumByMarker();
      }
      process.exit(1);
    }, 3000);
    forceExit.unref();

    // 關閉所有 TCP server（停止接受新連線）
    tcpServer.close();
    gwServer?.close();

    // 若正在啟動 Chromium，等待啟動完成後再清理
    // 防止 SIGTERM during starting 產生 orphan Chromium process
    // 注意：startChromium() 先 await 同一個 promise，resolve 後 microtask 按順序執行：
    // startChromium 先設好 playwrightServer / chromiumPID → 本 handler 接著清理
    if (launchPromise) {
      try { await launchPromise; } catch {}
    }

    // 關閉 Chromium（若有在跑）
    if (playwrightServer) {
      try { await playwrightServer.close(); } catch {}
    }
    killProcessTree(chromiumPID);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// 啟動主程式
main().catch((err) => {
  console.error('Failed to start browser host:', err);
  process.exit(1);
});
