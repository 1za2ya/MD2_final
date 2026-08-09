"use strict";

// 端末のフレームレートに関係なく同じ条件で足取りを比較できるよう、位置は0.1秒間隔で記録する。
const MOVEMENT_LOG_INTERVAL_MS = 100;
const POSITION_SEND_INTERVAL_MS = 100;
// 0.1秒ごとにAPI通信せず、約5秒分を一括送信してExpressとSQLite3の負荷を抑える。
const MOVEMENT_BATCH_SIZE = 50;
// 予備テストで調整できるよう、HUDの発光時間をゲーム設定値として一元管理する。
const COIN_STATUS_FLASH_MS = 300;
const PLAYER_RADIUS = 0.28;
const MOVE_SPEED = 2.7;
// 以下の判定値は予備実験後に調整できる暫定値で、現段階では分析定義を固定する目的で一元化する。
const STOP_SPEED_THRESHOLD = 0.08;
const TURN_THRESHOLD_DEGREES = 45;

const ui = {};
const state = {
  mode: "solo", socket: null, playerId: "", roomId: "solo", sessionId: "",
  previousSessionId: null, trialNumber: 0, roundNumber: null,
  stage: null, stageToken: "", mazeId: "basic", coinLayoutId: "basic_v1", randomSeed: 1,
  startedAt: null, running: false, finished: false, deviceMode: "desktop",
  collected: new Set(), movementBuffer: [], movementUploadPromise: Promise.resolve(), remotePlayers: new Map(), ranking: [],
  totalDistance: 0, maximumSpeed: 0, stopTime: 0, turnCount: 0, revisitCount: 0,
  deadEndCount: 0, visitedAreas: new Set(), currentArea: "", lastHeading: 0,
  lastPosition: null, lastSampleAt: 0, lastPositionSentAt: 0, lastCoinPosition: null,
  lastCoinAt: null, frameAt: 0, nextTimer: null, countdownTimer: null,
  nextRequested: false, intentionalLeave: false, needsRejoin: false, coinFlashFrame: null
};

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function worldPosition(row, column) {
  return { x: column * 2 - 1, z: row * 2 - 1 };
}

function totalCoins() {
  return state.stage?.coins.length || 0;
}

function currentAreaId(position) {
  const lastRow = state.stage.maze.length - 1;
  const lastColumn = state.stage.maze[0].length - 1;
  const column = Math.max(0, Math.min(lastColumn, Math.round((position.x + 1) / 2)));
  const row = Math.max(0, Math.min(lastRow, Math.round((position.z + 1) / 2)));
  return `area_${row}_${column}`;
}

function buildMaze() {
  const maze = document.querySelector("#maze");
  const coins = document.querySelector("#coins");
  maze.replaceChildren();
  coins.replaceChildren();
  state.stage.maze.forEach((line, row) => [...line].forEach((cell, column) => {
    if (cell !== "1") return;
    const position = worldPosition(row, column);
    const wall = document.createElement("a-entity");
    wall.setAttribute("mixin", "wall");
    wall.setAttribute("position", `${position.x} 1.35 ${position.z}`);
    wall.dataset.areaId = `wall_${row}_${column}`;
    maze.appendChild(wall);
  }));

  state.stage.coins.forEach(([row, column], index) => {
    const position = worldPosition(row, column);
    const coin = document.createElement("a-entity");
    coin.id = `coin_${String(index + 1).padStart(2, "0")}`;
    coin.classList.add("coin");
    coin.dataset.row = row;
    coin.dataset.column = column;
    coin.setAttribute("position", `${position.x} .7 ${position.z}`);
    coin.setAttribute("geometry", "primitive: torus; radius: .27; radiusTubular: .07; segmentsTubular: 12");
    coin.setAttribute("material", "color: #f5be38; emissive: #f5be38; emissiveIntensity: .75; metalness: .65; roughness: .25");
    coin.setAttribute("animation", "property: rotation; to: 0 360 0; loop: true; dur: 2400; easing: linear");
    coin.setAttribute("animation__float", `property: position; dir: alternate; loop: true; dur: 950; easing: easeInOutSine; to: ${position.x} .88 ${position.z}`);
    const light = document.createElement("a-entity");
    light.setAttribute("light", "type: point; color: #f5be38; intensity: .6; distance: 3");
    coin.appendChild(light);
    coins.appendChild(coin);
  });
  const floor = document.querySelector("#floor");
  const columns = state.stage.maze[0].length;
  const rows = state.stage.maze.length;
  floor.setAttribute("position", `${columns - 2} -0.05 ${rows - 2}`);
  floor.setAttribute("width", columns * 2);
  floor.setAttribute("height", rows * 2);
  ui.coinTotal.textContent = totalCoins();
  ui.coinRemaining.textContent = totalCoins();
  ui.stageName.textContent = state.stage.name.toUpperCase();
}

function collides(x, z) {
  for (let row = 0; row < state.stage.maze.length; row += 1) {
    for (let column = 0; column < state.stage.maze[row].length; column += 1) {
      if (state.stage.maze[row][column] !== "1") continue;
      const wall = worldPosition(row, column);
      if (Math.abs(x - wall.x) < 1 + PLAYER_RADIUS && Math.abs(z - wall.z) < 1 + PLAYER_RADIUS) return true;
    }
  }
  return false;
}

function isDeadEndArea(areaId) {
  const [, rowText, columnText] = areaId.split("_");
  const row = Number(rowText);
  const column = Number(columnText);
  const exits = [[1,0],[-1,0],[0,1],[0,-1]].filter(([dr, dc]) => state.stage.maze[row + dr]?.[column + dc] === "0");
  return exits.length === 1;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function elapsedSeconds() {
  return state.startedAt ? Math.max(0, (Date.now() - state.startedAt) / 1000) : 0;
}

function flashCoinStatusBar() {
  const statusBar = ui.coinStatusBar;
  if (!statusBar) return;
  try {
    // 短時間の連続取得でも毎回先頭から再生できるよう、発光クラスを一度外して次フレームで戻す。
    statusBar.classList.remove("coin-collected-flash");
    if (state.coinFlashFrame !== null) cancelAnimationFrame(state.coinFlashFrame);
    state.coinFlashFrame = requestAnimationFrame(() => {
      try {
        statusBar.classList.add("coin-collected-flash");
      } catch (error) {
        console.warn("coin status effect failed", error);
      }
      state.coinFlashFrame = null;
    });
  } catch (error) {
    // 視覚フィードバックの失敗で取得ログやゲーム進行を止めないため、表示エラーは分離して扱う。
    console.warn("coin status effect failed", error);
  }
}

async function postJson(url, body, keepalive = false) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function nearestOpponentDistance(position) {
  let nearest = Infinity;
  state.remotePlayers.forEach((remote) => {
    const p = remote.target;
    nearest = Math.min(nearest, Math.hypot(position.x - p.x, position.z - p.z));
  });
  return Number.isFinite(nearest) ? nearest : null;
}

function currentRank() {
  if (state.mode === "solo") return null;
  const own = state.ranking.find((player) => player.playerId === state.playerId);
  return own?.rank || 1;
}

// A-FrameのX-Z平面を分析用CSVのX-Yへ変換し、経過時間とともに時系列の足取りとして蓄積する。
function recordMovement(position, rotation, now) {
  if (!state.running || now - state.lastSampleAt < MOVEMENT_LOG_INTERVAL_MS) return;
  const elapsed = elapsedSeconds();
  const deltaSeconds = state.lastSampleAt ? (now - state.lastSampleAt) / 1000 : MOVEMENT_LOG_INTERVAL_MS / 1000;
  const distance = state.lastPosition ? Math.hypot(position.x - state.lastPosition.x, position.z - state.lastPosition.z) : 0;
  const speed = distance / Math.max(deltaSeconds, .001);
  state.totalDistance += distance;
  state.maximumSpeed = Math.max(state.maximumSpeed, speed);
  if (speed < STOP_SPEED_THRESHOLD) state.stopTime += deltaSeconds;

  let headingDelta = Math.abs((((rotation.y - state.lastHeading) % 360) + 540) % 360 - 180);
  if (headingDelta >= TURN_THRESHOLD_DEGREES) {
    state.turnCount += 1;
    state.lastHeading = rotation.y;
  }
  const areaId = currentAreaId(position);
  if (areaId !== state.currentArea) {
    if (state.visitedAreas.has(areaId)) state.revisitCount += 1;
    else state.visitedAreas.add(areaId);
    if (isDeadEndArea(areaId)) state.deadEndCount += 1;
    state.currentArea = areaId;
  }

  state.movementBuffer.push({ session_id: state.sessionId, player_id: state.playerId, room_id: state.roomId,
    game_mode: state.mode, elapsed_time: elapsed, pos_x: position.x, pos_y: position.z,
    rotation_y: rotation.y, speed,
    area_id: areaId, collected_coins: state.collected.size,
    remaining_coins: totalCoins() - state.collected.size,
    nearest_opponent_distance: nearestOpponentDistance(position), current_rank: currentRank() });
  state.lastPosition = { ...position };
  state.lastSampleAt = now;
  if (state.movementBuffer.length >= MOVEMENT_BATCH_SIZE) flushMovementLogs();
}

function recordCurrentMovement() {
  if (!state.running || state.finished) return;
  const player = document.querySelector("#player-rig").object3D.position;
  const cameraRotation = document.querySelector("#camera").object3D.rotation;
  recordMovement(
    { x: player.x, y: player.y, z: player.z },
    { x: THREE.MathUtils.radToDeg(cameraRotation.x), y: THREE.MathUtils.radToDeg(cameraRotation.y), z: THREE.MathUtils.radToDeg(cameraRotation.z) },
    performance.now()
  );
}

async function flushMovementLogs(keepalive = false) {
  if (!state.movementBuffer.length) return state.movementUploadPromise;
  const logs = state.movementBuffer.splice(0, state.movementBuffer.length);
  // 複数回の一括送信を順番に実行し、同一セッション内の時系列が前後しないようにする。
  const upload = state.movementUploadPromise.then(() => postJson("/api/logs/movements", { logs }, keepalive));
  state.movementUploadPromise = upload.catch((error) => {
    state.movementBuffer.unshift(...logs);
    console.error("movement log upload failed", error);
  });
  return state.movementUploadPromise;
}

function logEvent(eventType, detail = "") {
  if (!state.sessionId) return;
  const p = document.querySelector("#player-rig").object3D.position;
  postJson("/api/logs/events", { logs: [{ session_id: state.sessionId, player_id: state.playerId,
    room_id: state.roomId, event_type: eventType, elapsed_time: elapsedSeconds(),
    pos_x: p.x, pos_y: p.y, pos_z: p.z, detail }] }).catch(console.error);
}

function collectNearbyCoin(position) {
  if (!state.running || state.finished) return;
  for (const coin of document.querySelectorAll(".coin")) {
    if (state.collected.has(coin.id) || coin.dataset.collected === "true") continue;
    const coinPosition = coin.object3D.position;
    if (Math.hypot(position.x - coinPosition.x, position.z - coinPosition.z) > .72) continue;
    state.collected.add(coin.id);
    // 接触判定が連続しても加算・ログ・通信を一度だけにするため、DOM側にも取得済み状態を保持する。
    coin.dataset.collected = "true";
    coin.setAttribute("animation__collect", "property: scale; to: 0 0 0; dur: 220; easing: easeInBack");
    setTimeout(() => { coin.object3D.visible = false; }, 230);
    ui.coinCount.textContent = state.collected.size;
    const remainingCoins = totalCoins() - state.collected.size;
    ui.coinRemaining.textContent = remainingCoins;
    // コインが消えるだけでは認識しにくいため、常に見える右上HUDだけを短時間発光させる。
    flashCoinStatusBar();
    const now = Date.now();
    const distance = state.lastCoinPosition ? Math.hypot(position.x - state.lastCoinPosition.x, position.z - state.lastCoinPosition.z) : 0;
    const coinLog = { session_id: state.sessionId, player_id: state.playerId, room_id: state.roomId,
      coin_id: coin.id, coin_x: coinPosition.x, coin_y: coinPosition.y, coin_z: coinPosition.z,
      collected_order: state.collected.size, collected_time: new Date(now).toISOString(),
      elapsed_time: elapsedSeconds(), collected_coins: state.collected.size, remaining_coins: remainingCoins,
      distance_from_previous_coin: distance, time_from_previous_coin: state.lastCoinAt ? (now - state.lastCoinAt) / 1000 : 0,
      current_rank: currentRank() };
    state.lastCoinPosition = { x: position.x, z: position.z };
    state.lastCoinAt = now;
    postJson("/api/logs/coins", { logs: [coinLog] }).catch(console.error);
    logEvent("coin_collected", coin.id);
    state.socket?.emit("coin_collected", { coinId: coin.id, collectedCoins: state.collected.size });
    if (state.collected.size === totalCoins()) finishGame(true, "cleared");
    break;
  }
}

function updateRemotePlayers(deltaSeconds) {
  // 通信間隔ごとの座標へ瞬間移動させず、補間して相手の動きを読み取りやすくする。
  state.remotePlayers.forEach((remote) => {
    const p = remote.entity.object3D.position;
    const rate = Math.min(1, deltaSeconds * 10);
    p.x += (remote.target.x - p.x) * rate;
    p.y += (remote.target.y - p.y) * rate;
    p.z += (remote.target.z - p.z) * rate;
    remote.entity.object3D.rotation.y += (THREE.MathUtils.degToRad(remote.rotation.y) - remote.entity.object3D.rotation.y) * rate;
  });
}

// プレイヤーリグとカメラを分け、頭部の視点変化を床上の移動距離へ混入させない。
AFRAME.registerComponent("maze-controller", {
  init() {
    this.keys = new Set();
    window.addEventListener("keydown", (event) => this.keys.add(event.code));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
  },
  tick(time, deltaTime) {
    if (!state.running || state.finished) return;
    const dt = Math.min(deltaTime / 1000, .05);
    const camera = document.querySelector("#camera").object3D;
    const rotation = camera.rotation;
    let forward = (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0);
    let side = (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) - (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const gamepad = navigator.getGamepads?.()[0];
    if (gamepad) { side += gamepad.axes[2] || gamepad.axes[0] || 0; forward -= gamepad.axes[3] || gamepad.axes[1] || 0; }
    const length = Math.hypot(forward, side) || 1;
    forward /= length; side /= length;
    const yaw = rotation.y;
    const dx = (side * Math.cos(yaw) - forward * Math.sin(yaw)) * MOVE_SPEED * dt;
    const dz = (-forward * Math.cos(yaw) - side * Math.sin(yaw)) * MOVE_SPEED * dt;
    const p = this.el.object3D.position;
    if (!collides(p.x + dx, p.z)) p.x += dx;
    if (!collides(p.x, p.z + dz)) p.z += dz;
    const degrees = { x: THREE.MathUtils.radToDeg(rotation.x), y: THREE.MathUtils.radToDeg(rotation.y), z: THREE.MathUtils.radToDeg(rotation.z) };
    const position = { x: p.x, y: p.y, z: p.z };
    collectNearbyCoin(position);
    if (state.socket && performance.now() - state.lastPositionSentAt >= POSITION_SEND_INTERVAL_MS) {
      // 毎フレーム送らず、表示は受信側の補間に任せて通信負荷を抑える。
      state.socket.emit("player_position", { position, rotation: degrees });
      state.lastPositionSentAt = performance.now();
    }
    updateRemotePlayers(dt);
  }
});

function addRemotePlayer(player) {
  if (!player?.playerId || player.playerId === state.playerId || state.remotePlayers.has(player.playerId)) return;
  const avatar = document.createElement("a-entity");
  avatar.dataset.playerId = player.playerId;
  avatar.setAttribute("position", `${player.position.x} ${player.position.y} ${player.position.z}`);
  avatar.innerHTML = `<a-cylinder height="1.35" radius=".28" position="0 .72 0" material="color:#d8ebe5; roughness:.55"></a-cylinder><a-sphere radius=".24" position="0 1.55 0" material="color:#f5be38"></a-sphere><a-text value="${player.playerId}" align="center" width="3" position="0 2 0" side="double"></a-text>`;
  document.querySelector("#remote-players").appendChild(avatar);
  state.remotePlayers.set(player.playerId, { entity: avatar, target: { ...player.position }, rotation: player.rotation || { y: 0 } });
}

function removeRemotePlayer(playerId) {
  const remote = state.remotePlayers.get(playerId);
  remote?.entity.remove();
  state.remotePlayers.delete(playerId);
}

function renderRanking(players) {
  state.ranking = players;
  const own = players.find((player) => player.playerId === state.playerId);
  ui.rank.textContent = own?.rank || 1;
  ui.ranking.innerHTML = players.map((p) => `<div><span>${p.rank}. ${p.playerId === state.playerId ? "YOU" : p.playerId}</span><b>${p.collectedCoins}/${totalCoins()}</b></div>`).join("");
}

function resetRoundState() {
  // 前回の取得状態や座標が新しいセッションへ混ざらないよう、保存後にプレイ単位の状態だけを初期化する。
  state.startedAt = null;
  state.running = false;
  state.finished = false;
  state.collected = new Set();
  state.movementBuffer = [];
  state.movementUploadPromise = Promise.resolve();
  state.ranking = [];
  state.totalDistance = 0;
  state.maximumSpeed = 0;
  state.stopTime = 0;
  state.turnCount = 0;
  state.revisitCount = 0;
  state.deadEndCount = 0;
  state.visitedAreas = new Set();
  state.currentArea = "";
  state.lastHeading = 0;
  state.lastPosition = null;
  state.lastSampleAt = 0;
  state.lastPositionSentAt = 0;
  state.lastCoinPosition = null;
  state.lastCoinAt = null;
  state.nextRequested = false;
  if (state.coinFlashFrame !== null) cancelAnimationFrame(state.coinFlashFrame);
  state.coinFlashFrame = null;
  ui.coinStatusBar.classList.remove("coin-collected-flash");
  const start = worldPosition(...state.stage.start);
  document.querySelector("#player-rig").object3D.position.set(start.x, 0, start.z);
  document.querySelector("#camera").object3D.rotation.set(0, 0, 0);
  document.querySelectorAll(".coin").forEach((coin) => {
    coin.removeAttribute("animation__collect");
    coin.object3D.visible = true;
    coin.object3D.scale.set(1, 1, 1);
    coin.dataset.collected = "false";
  });
  state.remotePlayers.forEach((remote) => {
    remote.target = { x: 1, y: 0, z: 1 };
    remote.entity.object3D.position.set(1, 0, 1);
  });
  ui.timer.textContent = "00:00.0";
  ui.coinCount.textContent = "0";
  ui.coinRemaining.textContent = totalCoins();
  ui.rank.textContent = "1";
  ui.result.hidden = true;
  ui.roundResults.hidden = true;
  ui.nextButton.disabled = false;
  ui.nextButton.textContent = "NEXT GAME";
}

async function prepareRound(payload) {
  await flushMovementLogs(true);
  const previousSessionId = payload.previousSessionId ?? state.sessionId ?? null;
  resetRoundState();
  state.previousSessionId = previousSessionId;
  state.sessionId = payload.sessionId || uid("session");
  state.trialNumber = payload.trialNumber || state.trialNumber + 1;
  state.roundNumber = payload.roundNumber ?? null;
  state.mazeId = payload.mazeId || state.mazeId;
  state.coinLayoutId = payload.coinLayoutId || state.coinLayoutId;
  state.randomSeed = payload.randomSeed || state.randomSeed;
  startGame(payload.startedAt || Date.now());
}

function connectMultiplayer() {
  return new Promise((resolve, reject) => {
    state.socket = io();
    state.socket.on("connect_error", reject);
    state.socket.emit("join_room", { roomId: state.roomId, playerId: state.playerId, stageToken: state.stageToken }, (response) => {
      if (!response.ok) return reject(new Error(response.error));
      Object.assign(state, { mazeId: response.mazeId, coinLayoutId: response.coinLayoutId, randomSeed: response.randomSeed,
        roundNumber: response.roundNumber, trialNumber: response.trialNumber || 0 });
      response.players.forEach(addRemotePlayer);
      if (response.startedAt && response.sessionId) prepareRound(response);
      else if (response.phase === "results") {
        ui.status.textContent = "次ラウンドの開始待ち";
        ui.result.hidden = false;
        ui.nextStatus.textContent = "参加中のラウンド終了後に準備できます";
      } else if (response.phase === "running") {
        ui.status.textContent = "進行中のラウンド終了を待っています";
      } else { ui.status.textContent = "他の参加者を待っています"; state.socket.emit("player_ready"); }
      resolve();
    });
    state.socket.on("player_joined", addRemotePlayer);
    state.socket.on("player_left_room", ({ playerId }) => { removeRemotePlayer(playerId); logEvent("player_left", playerId); });
    state.socket.on("player_moved", (player) => {
      addRemotePlayer(player);
      const remote = state.remotePlayers.get(player.playerId);
      if (remote) { remote.target = player.position; remote.rotation = player.rotation; }
    });
    state.socket.on("ranking", renderRanking);
    state.socket.on("game_started", prepareRound);
    state.socket.on("next_round_started", prepareRound);
    state.socket.on("player_cleared", (player) => logEvent("opponent_cleared", player.playerId));
    state.socket.on("round_ended", ({ roundNumber, results }) => {
      state.roundNumber = roundNumber;
      ui.result.hidden = false;
      ui.nextButton.disabled = false;
      ui.nextStatus.textContent = `ROUND ${roundNumber} 完了 — 次のゲームへの準備を選択してください`;
      ui.roundResults.hidden = false;
      ui.roundResults.innerHTML = results.map((player) => `<div><span>${player.rank}. ${player.playerId}</span><span>${player.clearTime ? formatTime(player.clearTime) : "未クリア"} / ${player.collectedCoins} coins</span></div>`).join("");
    });
    state.socket.on("next_round_waiting", ({ players }) => {
      const readyCount = players.filter((player) => player.ready).length;
      ui.nextStatus.textContent = `準備完了 ${readyCount}/${players.length} — 全員の準備を待っています`;
    });
    state.socket.on("next_round_countdown", ({ roundNumber }) => {
      ui.nextStatus.textContent = `ROUND ${roundNumber} を開始します…`;
    });
    state.socket.on("round_time_limit", () => finishGame(false, "time_limit"));
    state.socket.on("room_closed", () => {
      ui.nextButton.disabled = true;
      ui.nextStatus.textContent = "参加人数が2人未満のため、次のゲームは開始できません";
    });
    state.socket.on("connect", () => {
      if (!state.needsRejoin) return;
      state.socket.emit("join_room", { roomId: state.roomId, playerId: state.playerId, stageToken: state.stageToken }, (response) => {
        if (!response.ok) return;
        state.needsRejoin = false;
        response.players.forEach(addRemotePlayer);
        ui.status.textContent = state.finished ? "ラウンド結果待ち" : "再接続しました";
        logEvent("reconnected");
      });
    });
    state.socket.on("disconnect", () => {
      if (state.intentionalLeave) return;
      state.needsRejoin = true;
      // 通信切断時も50件未満の座標を失わないよう、HTTPで未送信ログの保存を試みる。
      flushMovementLogs(true);
      logEvent("disconnected");
    });
  });
}

async function createSession() {
  await postJson("/api/sessions/start", { session_id: state.sessionId, previous_session_id: state.previousSessionId,
    player_id: state.playerId, room_id: state.roomId, game_mode: state.mode,
    trial_number: state.trialNumber, round_number: state.roundNumber, device_mode: state.deviceMode,
    maze_id: state.mazeId, coin_layout_id: state.coinLayoutId, random_seed: state.randomSeed,
    started_at: new Date(state.startedAt).toISOString(), total_coins: totalCoins(), stage_token: state.stageToken });
  logEvent("game_started");
}

function startGame(startedAt = Date.now()) {
  if (state.running || state.startedAt) return;
  state.startedAt = startedAt;
  ui.status.textContent = startedAt > Date.now() ? "開始待機中" : "探索中";
  createSession().catch((error) => { ui.status.textContent = "ログ保存エラー"; console.error(error); });
  setTimeout(() => {
    if (state.finished) return;
    state.running = true;
    ui.status.textContent = "探索中";
  }, Math.max(0, startedAt - Date.now()));
}

async function finishGame(isCleared, reason) {
  if (state.finished) return;
  state.finished = true;
  state.running = false;
  await flushMovementLogs(true);
  const clearTime = elapsedSeconds();
  const efficiency = state.totalDistance ? totalCoins() / state.totalDistance : null;
  await postJson(`/api/sessions/${state.sessionId}/finish`, { ended_at: new Date().toISOString(),
    clear_time: isCleared ? clearTime : null, total_distance: state.totalDistance,
    average_speed: clearTime ? state.totalDistance / clearTime : 0, maximum_speed: state.maximumSpeed,
    stop_time: state.stopTime, turn_count: state.turnCount, revisit_count: state.revisitCount,
    dead_end_count: state.deadEndCount, route_efficiency: efficiency,
    collected_coins: state.collected.size, final_rank: currentRank(), is_cleared: isCleared, end_reason: reason }, true).catch(console.error);
  logEvent(isCleared ? "cleared" : "ended", reason);
  state.socket?.emit("player_finished", { clearedAt: Date.now(), clearTime, isCleared });
  ui.resultTime.textContent = formatTime(clearTime);
  ui.resultDistance.textContent = `${state.totalDistance.toFixed(1)} m`;
  ui.resultTrial.textContent = state.mode === "multiplayer" ? `R${state.roundNumber}` : state.trialNumber;
  ui.resultCoins.textContent = `${state.collected.size}/${totalCoins()}`;
  ui.result.hidden = false;
  ui.status.textContent = state.mode === "multiplayer" ? "他プレイヤーの完了待ち" : "完了";
  if (state.mode === "multiplayer") {
    ui.nextButton.disabled = true;
    ui.nextStatus.textContent = "全プレイヤーのゲーム終了を待っています";
  } else {
    scheduleSoloNextRound();
  }
}

function scheduleSoloNextRound() {
  clearTimeout(state.nextTimer);
  clearInterval(state.countdownTimer);
  let remaining = 4;
  ui.nextStatus.textContent = `${remaining}秒後に次のゲームを開始します`;
  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    ui.nextStatus.textContent = remaining > 0 ? `${remaining}秒後に次のゲームを開始します` : "START";
  }, 1000);
  state.nextTimer = setTimeout(() => nextGame(), 4000);
}

async function nextGame() {
  clearTimeout(state.nextTimer);
  clearInterval(state.countdownTimer);
  if (state.mode === "multiplayer") {
    if (state.nextRequested) {
      state.nextRequested = false;
      ui.nextButton.textContent = "NEXT GAME";
      ui.nextStatus.textContent = "準備を取り消しました";
      state.socket.emit("cancel_next_round", { roomId: state.roomId, playerId: state.playerId });
    } else {
      state.nextRequested = true;
      ui.nextButton.textContent = "準備を取り消す";
      ui.nextStatus.textContent = "他のプレイヤーの準備を待っています";
      state.socket.emit("ready_for_next_round", { roomId: state.roomId, playerId: state.playerId });
    }
    return;
  }
  if (state.nextRequested) return;
  state.nextRequested = true;
  // 入力条件を引き継いで反復効果を分析しつつ、プレイ単位は新しいセッションIDで分離する。
  await prepareRound({ sessionId: uid("session"), previousSessionId: state.sessionId,
    trialNumber: state.trialNumber + 1, roundNumber: null, startedAt: Date.now() + 1000 });
}

async function exitContinuousPlay() {
  clearTimeout(state.nextTimer);
  clearInterval(state.countdownTimer);
  await flushMovementLogs(true);
  if (state.mode === "multiplayer") {
    state.intentionalLeave = true;
    state.socket?.emit("leave_room_after_game", { roomId: state.roomId, playerId: state.playerId });
    state.socket?.disconnect();
    state.socket = null;
  }
  state.remotePlayers.forEach((remote) => remote.entity.remove());
  state.remotePlayers.clear();
  state.running = false;
  state.finished = true;
  ui.result.hidden = true;
  ui.game.classList.add("inactive");
  ui.setup.hidden = false;
}

async function enterGame() {
  state.playerId = ui.playerId.value.trim();
  state.roomId = state.mode === "solo" ? `solo-${state.playerId}` : ui.roomId.value.trim().toUpperCase();
  if (!state.playerId || !state.roomId) { ui.setupError.textContent = "プレイヤーIDとルームIDを入力してください。"; return; }
  if (!/^[A-Za-z0-9_-]+$/.test(state.playerId) || !/^[A-Za-z0-9_-]+$/.test(state.roomId)) {
    ui.setupError.textContent = "IDには英数字、_、- だけを使用してください。"; return;
  }
  ui.setupError.textContent = "";
  try {
    const access = await postJson("/api/stages/access", { access_code: ui.stageCode.value });
    state.stage = access.stage;
    state.stageToken = access.stage_token;
    state.mazeId = access.stage.id;
    state.coinLayoutId = access.stage.coinLayoutId;
    buildMaze();
    resetRoundState();
    state.intentionalLeave = false;
    state.sessionId = state.mode === "solo" ? uid("session") : "";
    state.previousSessionId = null;
    state.trialNumber = state.mode === "solo" ? 1 : 0;
    state.roundNumber = null;
    ui.setup.hidden = true;
    ui.game.classList.remove("inactive");
    // 非表示要素内でWebGLを初期化するとキャンバスが0pxになる環境があるため、表示後に寸法を再計算する。
    requestAnimationFrame(() => {
      const scene = document.querySelector("#scene");
      scene.resize?.();
      window.dispatchEvent(new Event("resize"));
    });
    ui.rankBox.hidden = state.mode === "solo";
    ui.ranking.hidden = state.mode === "solo";
    if (state.mode === "multiplayer") await connectMultiplayer();
    else startGame(Date.now());
  } catch (error) {
    ui.setup.hidden = false; ui.game.classList.add("inactive");
    ui.setupError.textContent = `接続できませんでした: ${error.message}`;
  }
}

function bindUi() {
  Object.assign(ui, {
    setup: document.querySelector("#setup"), game: document.querySelector("#game"), playerId: document.querySelector("#player-id"),
    roomId: document.querySelector("#room-id"), roomField: document.querySelector("#room-field"), stageCode: document.querySelector("#stage-code"),
    setupError: document.querySelector("#setup-error"), stageName: document.querySelector("#stage-name"),
    status: document.querySelector("#status"), timer: document.querySelector("#timer"), coinCount: document.querySelector("#coin-count"),
    coinTotal: document.querySelector("#coin-total"), coinRemaining: document.querySelector("#coin-remaining"),
    coinStatusBar: document.querySelector("#coin-status-bar"), rankBox: document.querySelector("#rank-box"), rank: document.querySelector("#rank"),
    ranking: document.querySelector("#ranking"), result: document.querySelector("#result"), resultTime: document.querySelector("#result-time"),
    resultDistance: document.querySelector("#result-distance"), resultTrial: document.querySelector("#result-trial"),
    resultCoins: document.querySelector("#result-coins"), roundResults: document.querySelector("#round-results"),
    nextStatus: document.querySelector("#next-status"), nextButton: document.querySelector("#next-button")
  });
  ui.playerId.value = `P-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  ui.coinStatusBar.style.setProperty("--coin-flash-duration", `${COIN_STATUS_FLASH_MS}ms`);
  ui.coinStatusBar.addEventListener("animationend", () => ui.coinStatusBar.classList.remove("coin-collected-flash"));
  document.querySelectorAll(".mode").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".mode").forEach((item) => item.classList.toggle("active", item === button));
    state.mode = button.dataset.mode;
    ui.roomField.hidden = state.mode === "solo";
  }));
  document.querySelector("#enter-button").addEventListener("click", enterGame);
  ui.nextButton.addEventListener("click", nextGame);
  document.querySelector("#exit-button").addEventListener("click", exitContinuousPlay);
  document.querySelector("#scene").addEventListener("enter-vr", () => {
    state.deviceMode = "vr";
    if (state.sessionId) postJson(`/api/sessions/${state.sessionId}/device`, { device_mode: "vr" }).catch(console.error);
    logEvent("device_mode_changed", "vr");
  });
  // 描画フレームとは独立したタイマーを使い、端末性能によって記録件数が変わることを防ぐ。
  setInterval(recordCurrentMovement, MOVEMENT_LOG_INTERVAL_MS);
  setInterval(() => { if (state.running) ui.timer.textContent = formatTime(elapsedSeconds()); }, 100);
}

window.addEventListener("beforeunload", () => {
  if (!state.sessionId || state.finished) return;
  if (state.movementBuffer.length) navigator.sendBeacon("/api/logs/movements", new Blob([JSON.stringify({ logs: state.movementBuffer })], { type: "application/json" }));
  const clearTime = elapsedSeconds();
  navigator.sendBeacon(`/api/sessions/${state.sessionId}/finish`, new Blob([JSON.stringify({ ended_at: new Date().toISOString(), clear_time: null,
    total_distance: state.totalDistance, average_speed: clearTime ? state.totalDistance / clearTime : 0,
    maximum_speed: state.maximumSpeed, stop_time: state.stopTime, turn_count: state.turnCount,
    revisit_count: state.revisitCount, dead_end_count: state.deadEndCount, route_efficiency: null,
    collected_coins: state.collected.size, final_rank: currentRank(), is_cleared: false, end_reason: "page_closed" })], { type: "application/json" }));
});

document.addEventListener("DOMContentLoaded", bindUi);
