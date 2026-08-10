"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "game.db");
const EXPORT_DIR = path.join(DATA_DIR, "exports");
const POSITION_INTERVAL_MS = 100;
const MAX_POSITION_DELTA = 8;
const GENERATED_EXPORT_TOKEN = !process.env.MD2_EXPORT_TOKEN;
const EXPORT_TOKEN = process.env.MD2_EXPORT_TOKEN || crypto.randomBytes(18).toString("hex");
const BASIC_STAGE = Object.freeze({
  id: "basic", name: "Basic Research Stage", coinLayoutId: "basic_v1", start: [1, 1],
  maze: ["111111111","100000001","101110101","100010101","111010101","100010001","101111101","100000001","111111111"],
  coins: [[1,3],[1,7],[3,1],[3,5],[5,1],[5,7],[7,3],[7,7]]
});

fs.mkdirSync(EXPORT_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new sqlite3.Database(DB_PATH);
const rooms = new Map();
let batchQueue = Promise.resolve();

app.use(express.json({ limit: "2mb" }));
// 実行時に外部CDNへ依存するとオフライン環境で3Dシーンが初期化されないため、A-Frameをローカル配信する。
app.use("/vendor/aframe", express.static(path.join(__dirname, "node_modules", "aframe", "dist")));
app.use(express.static(path.join(__dirname, "public")));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

const MOVEMENT_TABLE_SQL = `CREATE TABLE movement_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, player_id TEXT NOT NULL,
  room_id TEXT, game_mode TEXT NOT NULL CHECK(game_mode IN ('solo','multiplayer')),
  elapsed_time REAL NOT NULL, pos_x REAL NOT NULL, pos_y REAL NOT NULL,
  rotation_y REAL, speed REAL, area_id TEXT, collected_coins INTEGER,
  remaining_coins INTEGER, nearest_opponent_distance REAL, current_rank INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
)`;

async function initializeDatabase() {
  // 外部キーで孤立ログを防ぎ、分析時にセッションとの対応が必ず追跡できるようにする。
  await run("PRAGMA foreign_keys = ON");
  await run(`CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, previous_session_id TEXT, player_id TEXT NOT NULL, room_id TEXT NOT NULL,
    game_mode TEXT NOT NULL CHECK(game_mode IN ('solo','multiplayer')),
    trial_number INTEGER NOT NULL DEFAULT 1, round_number INTEGER, device_mode TEXT NOT NULL,
    maze_id TEXT NOT NULL, coin_layout_id TEXT NOT NULL, random_seed INTEGER NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, clear_time REAL, total_distance REAL DEFAULT 0,
    average_speed REAL DEFAULT 0, maximum_speed REAL DEFAULT 0, stop_time REAL DEFAULT 0,
    turn_count INTEGER DEFAULT 0, revisit_count INTEGER DEFAULT 0, dead_end_count INTEGER DEFAULT 0,
    route_efficiency REAL, collected_coins INTEGER DEFAULT 0, total_coins INTEGER NOT NULL,
    final_rank INTEGER, is_cleared INTEGER DEFAULT 0, end_reason TEXT
  )`);
  const sessionColumns = await all("PRAGMA table_info(sessions)");
  if (!sessionColumns.some((column) => column.name === "previous_session_id")) {
    await run("ALTER TABLE sessions ADD COLUMN previous_session_id TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "round_number")) {
    await run("ALTER TABLE sessions ADD COLUMN round_number INTEGER");
  }

  const movementColumns = await all("PRAGMA table_info(movement_logs)");
  if (movementColumns.length === 0) {
    await run(MOVEMENT_TABLE_SQL);
  } else if (movementColumns.some((column) => column.name === "pos_z") || !movementColumns.some((column) => column.name === "game_mode")) {
    // 18項追加前のX-Y-Z形式を残すと高さを平面Yと誤解するため、X-Zを新しいX-Yへ写して移行する。
    await run("PRAGMA foreign_keys = OFF");
    await run("BEGIN TRANSACTION");
    try {
      await run(MOVEMENT_TABLE_SQL.replace("movement_logs", "movement_logs_new"));
      await run(`INSERT INTO movement_logs_new
        (id,session_id,player_id,room_id,game_mode,elapsed_time,pos_x,pos_y,rotation_y,speed,area_id,
         collected_coins,remaining_coins,nearest_opponent_distance,current_rank)
        SELECT m.id,m.session_id,m.player_id,m.room_id,s.game_mode,m.elapsed_time,m.pos_x,m.pos_z,m.rotation_y,
         m.speed,m.area_id,m.collected_coins,m.remaining_coins,m.nearest_opponent_distance,m.current_rank
        FROM movement_logs m JOIN sessions s ON s.session_id=m.session_id
        WHERE m.id IN (SELECT MIN(id) FROM movement_logs GROUP BY session_id, elapsed_time)`);
      await run("DROP TABLE movement_logs");
      await run("ALTER TABLE movement_logs_new RENAME TO movement_logs");
      await run("COMMIT");
    } catch (error) {
      await run("ROLLBACK");
      throw error;
    } finally {
      await run("PRAGMA foreign_keys = ON");
    }
  }
  // 再送された同一時点のログをDB側でも拒否し、CSVの経路密度が二重にならないようにする。
  await run(`DELETE FROM movement_logs
    WHERE id NOT IN (SELECT MIN(id) FROM movement_logs GROUP BY session_id, elapsed_time)`);
  await run("CREATE UNIQUE INDEX IF NOT EXISTS movement_session_time ON movement_logs(session_id, elapsed_time)");

  await run(`CREATE TABLE IF NOT EXISTS coin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, player_id TEXT NOT NULL,
    room_id TEXT NOT NULL, coin_id TEXT NOT NULL, coin_x REAL, coin_y REAL, coin_z REAL,
    collected_order INTEGER, collected_time TEXT, elapsed_time REAL,
    collected_coins INTEGER, remaining_coins INTEGER, distance_from_previous_coin REAL,
    time_from_previous_coin REAL, current_rank INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`);
  const coinColumns = await all("PRAGMA table_info(coin_logs)");
  if (!coinColumns.some((column) => column.name === "elapsed_time")) {
    await run("ALTER TABLE coin_logs ADD COLUMN elapsed_time REAL");
  }
  if (!coinColumns.some((column) => column.name === "collected_coins")) {
    await run("ALTER TABLE coin_logs ADD COLUMN collected_coins INTEGER");
  }
  if (!coinColumns.some((column) => column.name === "remaining_coins")) {
    await run("ALTER TABLE coin_logs ADD COLUMN remaining_coins INTEGER");
  }
  // クライアント再送時にも同じコインの取得ログを増やさず、取得順序と集計値を一意に保つ。
  await run(`DELETE FROM coin_logs
    WHERE id NOT IN (SELECT MIN(id) FROM coin_logs GROUP BY session_id, coin_id)`);
  await run("CREATE UNIQUE INDEX IF NOT EXISTS coin_session_id ON coin_logs(session_id, coin_id)");
  await run(`CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, player_id TEXT NOT NULL,
    room_id TEXT NOT NULL, event_type TEXT NOT NULL, elapsed_time REAL, pos_x REAL,
    pos_y REAL, pos_z REAL, detail TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`);
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/stage", (_req, res) => res.json(BASIC_STAGE));

app.post("/api/sessions/start", asyncRoute(async (req, res) => {
  const s = req.body;
  const required = ["session_id", "player_id", "room_id", "game_mode", "device_mode", "maze_id", "coin_layout_id", "random_seed", "started_at", "total_coins"];
  if (required.some((key) => s[key] === undefined || s[key] === "")) {
    return res.status(400).json({ error: "required session field is missing" });
  }
  if (s.maze_id !== BASIC_STAGE.id || s.coin_layout_id !== BASIC_STAGE.coinLayoutId || Number(s.total_coins) !== BASIC_STAGE.coins.length) {
    return res.status(400).json({ error: "stage settings do not match" });
  }
  // 値をSQLへ直接埋め込まず、ログAPIからの入力を安全に保存する。
  await run("INSERT OR IGNORE INTO players (player_id, created_at) VALUES (?, ?)",
    [s.player_id, s.started_at]);
  await run(`INSERT OR IGNORE INTO sessions
    (session_id,previous_session_id,player_id,room_id,game_mode,trial_number,round_number,device_mode,maze_id,coin_layout_id,random_seed,started_at,total_coins)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.session_id, s.previous_session_id || null, s.player_id, s.room_id, s.game_mode, s.trial_number || 1,
      s.round_number || null, s.device_mode,
      s.maze_id, s.coin_layout_id, s.random_seed, s.started_at, s.total_coins]);
  res.status(201).json({ ok: true });
}));

async function executeBatch(table, columns, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const placeholders = columns.map(() => "?").join(",");
  await run("BEGIN TRANSACTION");
  try {
    // 位置ログを一括トランザクション化し、1件ずつ確定するDB負荷を避ける。
    for (const row of rows) {
      const insertCommand = ["movement_logs", "coin_logs"].includes(table) ? "INSERT OR IGNORE" : "INSERT";
      await run(`${insertCommand} INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`, columns.map((c) => row[c] ?? null));
    }
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    throw error;
  }
}

function insertBatch(table, columns, rows) {
  // 単一SQLite接続で複数トランザクションが重ならないよう直列化し、同時プレイ時の保存失敗を防ぐ。
  const operation = batchQueue.then(() => executeBatch(table, columns, rows));
  batchQueue = operation.catch(() => undefined);
  return operation;
}

app.post("/api/logs/movements", asyncRoute(async (req, res) => {
  const columns = ["session_id","player_id","room_id","game_mode","elapsed_time","pos_x","pos_y","rotation_y","speed","area_id","collected_coins","remaining_coins","nearest_opponent_distance","current_rank"];
  await insertBatch("movement_logs", columns, req.body.logs);
  res.status(201).json({ ok: true, count: req.body.logs?.length || 0 });
}));

app.post("/api/logs/coins", asyncRoute(async (req, res) => {
  const columns = ["session_id","player_id","room_id","coin_id","coin_x","coin_y","coin_z","collected_order","collected_time","elapsed_time","collected_coins","remaining_coins","distance_from_previous_coin","time_from_previous_coin","current_rank"];
  await insertBatch("coin_logs", columns, req.body.logs);
  res.status(201).json({ ok: true });
}));

app.post("/api/logs/events", asyncRoute(async (req, res) => {
  const columns = ["session_id","player_id","room_id","event_type","elapsed_time","pos_x","pos_y","pos_z","detail"];
  await insertBatch("event_logs", columns, req.body.logs);
  res.status(201).json({ ok: true });
}));

app.post("/api/sessions/:id/finish", asyncRoute(async (req, res) => {
  const s = req.body;
  await run(`UPDATE sessions SET ended_at=?,clear_time=?,total_distance=?,average_speed=?,maximum_speed=?,
    stop_time=?,turn_count=?,revisit_count=?,dead_end_count=?,route_efficiency=?,collected_coins=?,
    final_rank=?,is_cleared=?,end_reason=? WHERE session_id=?`,
    [s.ended_at, s.clear_time, s.total_distance, s.average_speed, s.maximum_speed, s.stop_time,
      s.turn_count, s.revisit_count, s.dead_end_count, s.route_efficiency, s.collected_coins,
      s.final_rank, s.is_cleared ? 1 : 0, s.end_reason, req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/sessions/:id/device", asyncRoute(async (req, res) => {
  if (!["desktop", "vr"].includes(req.body.device_mode)) return res.status(400).json({ error: "invalid device mode" });
  // ゲーム開始後にVRへ入る場合も、操作環境を誤ってdesktopとして分析しないためセッションを更新する。
  await run("UPDATE sessions SET device_mode=? WHERE session_id=?", [req.body.device_mode, req.params.id]);
  res.json({ ok: true });
}));

const exportsConfig = {
  sessions: { table: "sessions", columns: ["session_id","previous_session_id","player_id","room_id","game_mode","trial_number","round_number","device_mode","maze_id","coin_layout_id","random_seed","started_at","ended_at","clear_time","total_distance","average_speed","maximum_speed","stop_time","turn_count","revisit_count","dead_end_count","route_efficiency","collected_coins","total_coins","final_rank","is_cleared","end_reason"] },
  movement_logs: { table: "movement_logs", columns: ["session_id","player_id","room_id","game_mode","elapsed_time","pos_x","pos_y","rotation_y","speed","area_id","collected_coins","remaining_coins","nearest_opponent_distance","current_rank"], orderBy: "session_id, elapsed_time" },
  coin_logs: { table: "coin_logs", columns: ["session_id","player_id","room_id","coin_id","coin_x","coin_y","coin_z","collected_order","collected_time","elapsed_time","collected_coins","remaining_coins","distance_from_previous_coin","time_from_previous_coin","current_rank"], orderBy: "session_id, collected_order" },
  event_logs: { table: "event_logs", columns: ["session_id","player_id","room_id","event_type","elapsed_time","pos_x","pos_y","pos_z","detail"] }
};

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const string = String(value);
  return /[",\n\r]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

app.get("/api/export/:name", asyncRoute(async (req, res) => {
  // 生の実験データへ一般プレイヤーがアクセスできないよう、管理トークンはサーバーだけで検証する。
  const suppliedToken = String(req.get("x-export-token") || "");
  const suppliedBuffer = Buffer.from(suppliedToken);
  const expectedBuffer = Buffer.from(EXPORT_TOKEN);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: "export authorization required" });
  }
  const config = exportsConfig[req.params.name];
  if (!config) return res.status(404).json({ error: "unknown export" });
  const rows = await all(`SELECT ${config.columns.join(",")} FROM ${config.table}${config.orderBy ? ` ORDER BY ${config.orderBy}` : ""}`);
  // 列順と移動ログの時系列順を固定し、pandas側で足取りを正しく線で結べるようにする。
  const csv = [config.columns.join(","), ...rows.map((row) => config.columns.map((column) => csvCell(row[column])).join(","))].join("\n");
  const filename = `${req.params.name}.csv`;
  fs.writeFileSync(path.join(EXPORT_DIR, filename), `${csv}\n`, "utf8");
  res.type("text/csv").attachment(filename).send(`${csv}\n`);
}));

function publicPlayer(player) {
  return { playerId: player.playerId, position: player.position, rotation: player.rotation,
    collectedCoins: player.collectedCoins, cleared: player.cleared, finished: player.finished,
    clearTime: player.clearTime, rank: player.rank, connected: player.connected,
    isReadyForNextRound: player.isReadyForNextRound };
}

const ROOM_TIME_LIMIT_MS = 5 * 60 * 1000;
const RECONNECT_GRACE_MS = 15 * 1000;

function connectedPlayers(room) {
  return [...room.players.values()].filter((player) => player.connected);
}

function updateRanks(room) {
  const ordered = connectedPlayers(room).filter((player) => player.participating).sort((a, b) => {
    if (a.clearedAt && b.clearedAt) return a.clearedAt - b.clearedAt;
    if (a.clearedAt) return -1;
    if (b.clearedAt) return 1;
    return b.collectedCoins - a.collectedCoins;
  });
  ordered.forEach((player, index) => { player.rank = index + 1; });
  io.to(room.id).emit("ranking", ordered.map(publicPlayer));
}

function resetServerPlayerForRound(player) {
  player.participating = true;
  player.position = { x: 1, y: 0, z: 1 };
  player.rotation = { x: 0, y: 0, z: 0 };
  player.collectedCoins = 0;
  player.cleared = false;
  player.finished = false;
  player.clearedAt = null;
  player.clearTime = null;
  player.rank = 1;
  player.isReadyForNextRound = false;
  player.lastPositionAt = 0;
}

function startRoomRound(room, eventName) {
  room.phase = "running";
  room.startedAt = Date.now() + 3000;
  // 同じ参加者の反復を追跡しつつログを混在させないため、各ラウンドで個別のセッションIDを発行する。
  for (const player of connectedPlayers(room)) {
    player.previousSessionId = player.sessionId || null;
    player.sessionId = `session_${crypto.randomUUID()}`;
    player.trialNumber = (player.trialNumber || 0) + 1;
    resetServerPlayerForRound(player);
    io.to(player.socketId).emit(eventName, {
      roomId: room.id, roundNumber: room.roundNumber, sessionId: player.sessionId,
      previousSessionId: player.previousSessionId, trialNumber: player.trialNumber,
      mazeId: room.mazeId, coinLayoutId: room.coinLayoutId,
      randomSeed: room.randomSeed, startedAt: room.startedAt
    });
  }
  clearTimeout(room.limitTimer);
  room.limitTimer = setTimeout(() => {
    io.to(room.id).emit("round_time_limit");
    setTimeout(() => endRoomRound(room, "time_limit"), 2000);
  }, ROOM_TIME_LIMIT_MS + 3000);
  updateRanks(room);
}

function endRoomRound(room, reason = "all_finished") {
  if (room.phase === "results") return;
  room.phase = "results";
  clearTimeout(room.limitTimer);
  updateRanks(room);
  const results = connectedPlayers(room).filter((player) => player.participating).sort((a, b) => a.rank - b.rank).map(publicPlayer);
  io.to(room.id).emit("round_ended", { roundNumber: room.roundNumber, reason, results });
}

function readinessState(room) {
  return [...room.players.values()].map((player) => ({
    playerId: player.playerId, ready: player.isReadyForNextRound, connected: player.connected
  }));
}

function tryStartNextRound(room) {
  if (room.phase !== "results") return;
  const active = connectedPlayers(room);
  // 再接続猶予中の参加者を即座に除外せず、残る全員の準備状態が確定してから次ラウンドへ進む。
  const allParticipantsReady = [...room.players.values()].every((player) => player.connected && player.isReadyForNextRound);
  if (active.length >= 2 && allParticipantsReady) {
    room.roundNumber += 1;
    io.to(room.id).emit("next_round_countdown", { roundNumber: room.roundNumber, startedAt: Date.now() + 3000 });
    startRoomRound(room, "next_round_started");
  }
}

function removePlayerFromRoom(room, player, eventName = "player_left_room") {
  clearTimeout(player.reconnectTimer);
  room.players.delete(player.socketId);
  io.to(room.id).emit(eventName, { playerId: player.playerId });
  const remaining = connectedPlayers(room);
  if (remaining.length === 0) {
    clearTimeout(room.limitTimer);
    rooms.delete(room.id);
  } else if (remaining.length < 2 && room.phase !== "running") {
    io.to(room.id).emit("room_closed", { reason: "not_enough_players" });
  }
  updateRanks(room);
  tryStartNextRound(room);
}

io.on("connection", (socket) => {
  socket.on("join_room", (payload, acknowledge = () => {}) => {
    const roomId = String(payload.roomId || "").trim().slice(0, 32);
    const playerId = String(payload.playerId || "").trim().slice(0, 64);
    if (!roomId || !playerId) return acknowledge({ ok: false, error: "roomId and playerId are required" });
    if (!/^[A-Za-z0-9_-]+$/.test(roomId) || !/^[A-Za-z0-9_-]+$/.test(playerId)) {
      return acknowledge({ ok: false, error: "IDs may contain only letters, numbers, _ and -" });
    }
    let room = rooms.get(roomId);
    if (!room) {
      room = { id: roomId, mazeId: BASIC_STAGE.id,
        coinLayoutId: BASIC_STAGE.coinLayoutId, totalCoins: BASIC_STAGE.coins.length,
        randomSeed: crypto.randomInt(1, 2147483647), startedAt: null,
        roundNumber: 1, phase: "waiting", players: new Map(), limitTimer: null };
      rooms.set(roomId, room);
    }
    const connectedDuplicate = [...room.players.values()].find((candidate) => candidate.playerId === playerId && candidate.connected);
    if (connectedDuplicate) return acknowledge({ ok: false, error: "playerId is already connected to this room" });
    // 一時切断でルームと連続試行の関係を失わないよう、猶予時間内は同じplayerIdの状態を復元する。
    const disconnectedEntry = [...room.players.entries()].find(([, candidate]) => candidate.playerId === playerId && !candidate.connected);
    const player = disconnectedEntry?.[1] || { playerId, trialNumber: 0, sessionId: null, previousSessionId: null };
    if (disconnectedEntry) {
      clearTimeout(player.reconnectTimer);
      room.players.delete(disconnectedEntry[0]);
    } else {
      resetServerPlayerForRound(player);
      // 進行中に入ったプレイヤーは条件が揃わないため観戦状態とし、次ラウンドから参加させる。
      player.participating = room.phase !== "running";
    }
    player.socketId = socket.id;
    player.connected = true;
    player.ready = false;
    room.players.set(socket.id, player);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socket.join(roomId);
    socket.to(roomId).emit("player_joined", publicPlayer(player));
    acknowledge({ ok: true, mazeId: room.mazeId, coinLayoutId: room.coinLayoutId,
      randomSeed: room.randomSeed, phase: room.phase, roundNumber: room.roundNumber,
      startedAt: player.sessionId && room.phase === "running" ? room.startedAt : null,
      sessionId: player.sessionId, previousSessionId: player.previousSessionId, trialNumber: player.trialNumber,
      players: [...room.players.values()].filter((p) => p.socketId !== socket.id).map(publicPlayer) });
    updateRanks(room);
  });

  socket.on("player_ready", () => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== "waiting") return;
    player.ready = true;
    // 各端末の時計差を結果へ混ぜないよう、全員の準備後にサーバー時刻で開始する。
    const active = connectedPlayers(room);
    if (active.length >= 2 && active.every((p) => p.ready)) {
      startRoomRound(room, "game_started");
    }
  });

  socket.on("player_position", (payload) => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || !player.participating || room.phase !== "running" || !payload?.position) return;
    const now = Date.now();
    if (now - player.lastPositionAt < POSITION_INTERVAL_MS * 0.7) return;
    const next = payload.position;
    const delta = Math.hypot(next.x - player.position.x, next.y - player.position.y, next.z - player.position.z);
    // 瞬間移動に相当する異常座標を共有せず、競争条件とログ品質を保護する。
    if (![next.x, next.y, next.z].every(Number.isFinite) || delta > MAX_POSITION_DELTA) return;
    player.position = { x: next.x, y: next.y, z: next.z };
    player.rotation = payload.rotation || player.rotation;
    player.lastPositionAt = now;
    socket.to(room.id).emit("player_moved", publicPlayer(player));
  });

  socket.on("coin_collected", (payload) => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || !player.participating || room.phase !== "running") return;
    // コイン状態はプレイヤーごとに独立させ、soloとの比較条件を揃える。
    player.collectedCoins = Math.min(room.totalCoins, Math.max(player.collectedCoins, Number(payload?.collectedCoins) || 0));
    socket.to(room.id).emit("opponent_coin", { playerId: player.playerId, collectedCoins: player.collectedCoins });
    updateRanks(room);
  });

  socket.on("player_finished", (payload) => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || !player.participating || player.finished) return;
    player.finished = true;
    player.cleared = payload?.isCleared !== false;
    player.clearedAt = player.cleared ? (Number(payload?.clearedAt) || Date.now()) : null;
    player.clearTime = player.cleared ? Number(payload?.clearTime) || null : null;
    updateRanks(room);
    io.to(room.id).emit("player_cleared", publicPlayer(player));
    if (connectedPlayers(room).filter((candidate) => candidate.participating).every((candidate) => candidate.finished)) endRoomRound(room);
  });

  socket.on("ready_for_next_round", () => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== "results") return;
    player.isReadyForNextRound = true;
    io.to(room.id).emit("player_ready_for_next_round", { playerId: player.playerId });
    io.to(room.id).emit("next_round_waiting", { players: readinessState(room) });
    // ルームを維持したまま同じ条件で比較するため、全員が準備してからラウンドだけを進める。
    tryStartNextRound(room);
  });

  socket.on("cancel_next_round", () => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    player.isReadyForNextRound = false;
    io.to(room.id).emit("next_round_waiting", { players: readinessState(room) });
  });

  socket.on("leave_room_after_game", () => {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    socket.leave(room.id);
    removePlayerFromRoom(room, player);
    socket.data.roomId = null;
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.connected = false;
    socket.to(room.id).emit("player_disconnected", { playerId: player.playerId, reconnectGraceMs: RECONNECT_GRACE_MS });
    // 短い通信断でルームを解散すると連続実験が途切れるため、猶予後にだけ参加対象から除外する。
    player.reconnectTimer = setTimeout(() => {
      removePlayerFromRoom(room, player, "player_left_room");
      if (room.phase === "running" && connectedPlayers(room).filter((candidate) => candidate.participating).every((candidate) => candidate.finished)) endRoomRound(room, "remaining_players_finished");
    }, RECONNECT_GRACE_MS);
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal server error" });
});

initializeDatabase()
  .then(() => server.listen(PORT, "0.0.0.0", () => {
    console.log(`Maze research server: http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    if (GENERATED_EXPORT_TOKEN) console.log(`CSV export token: ${EXPORT_TOKEN}`);
  }))
  .catch((error) => {
    console.error("Database initialization failed", error);
    db.close(() => process.exit(1));
  });

function shutdown() {
  io.close();
  server.close(() => db.close(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
