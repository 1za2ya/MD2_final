"use strict";

const assert = require("assert");
const { io } = require("socket.io-client");

const baseUrl = process.env.MD2_TEST_URL || "http://127.0.0.1:3100";

function event(socket, name, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${name}`)), timeout);
    socket.once(name, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function join(socket, playerId) {
  return new Promise((resolve, reject) => {
    socket.emit("join_room", { roomId: "ROUND-TEST", playerId }, (response) => {
      if (response.ok) resolve(response);
      else reject(new Error(response.error));
    });
  });
}

async function main() {
  const first = io(baseUrl, { transports: ["websocket"] });
  const second = io(baseUrl, { transports: ["websocket"] });
  const connections = [event(first, "connect"), event(second, "connect")];
  const stage = await fetch(`${baseUrl}/api/stage`).then((response) => response.json());
  assert.equal(stage.id, "basic");
  assert.equal(stage.coins.length, 8);
  const sessionPayload = {
    session_id: `stage_test_${Date.now()}`, player_id: "TEST-STAGE", room_id: "solo-TEST-STAGE",
    game_mode: "solo", trial_number: 1, device_mode: "desktop", maze_id: "basic",
    coin_layout_id: "basic_v1", random_seed: 1, started_at: new Date().toISOString(),
    total_coins: 8
  };
  const validSession = await fetch(`${baseUrl}/api/sessions/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sessionPayload)
  });
  assert.equal(validSession.status, 201);
  const mismatchedSession = await fetch(`${baseUrl}/api/sessions/start`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sessionPayload, session_id: `${sessionPayload.session_id}_bad`, maze_id: "invalid", total_coins: 6 })
  });
  assert.equal(mismatchedSession.status, 400);
  await Promise.all(connections);
  await Promise.all([join(first, "TEST-A"), join(second, "TEST-B")]);

  const initialEvents = [event(first, "game_started"), event(second, "game_started")];
  first.emit("player_ready");
  second.emit("player_ready");
  const initial = await Promise.all(initialEvents);
  assert.equal(initial[0].roundNumber, 1);
  assert.notEqual(initial[0].sessionId, initial[1].sessionId);

  const endedEvents = [event(first, "round_ended"), event(second, "round_ended")];
  first.emit("player_finished", { isCleared: true, clearedAt: Date.now(), clearTime: 10 });
  second.emit("player_finished", { isCleared: true, clearedAt: Date.now() + 1, clearTime: 12 });
  await Promise.all(endedEvents);

  const nextEvents = [event(first, "next_round_started"), event(second, "next_round_started")];
  first.emit("ready_for_next_round");
  second.emit("ready_for_next_round");
  const next = await Promise.all(nextEvents);
  assert.equal(next[0].roundNumber, 2);
  assert.equal(next[0].previousSessionId, initial[0].sessionId);
  assert.equal(next[1].previousSessionId, initial[1].sessionId);
  assert.notEqual(next[0].sessionId, initial[0].sessionId);

  first.emit("leave_room_after_game");
  second.emit("leave_room_after_game");
  first.disconnect();
  second.disconnect();

  const unauthorizedExport = await fetch(`${baseUrl}/api/export/sessions`);
  assert.equal(unauthorizedExport.status, 401);
  if (process.env.MD2_EXPORT_TOKEN) {
    const authorizedExport = await fetch(`${baseUrl}/api/export/sessions`, { headers: { "x-export-token": process.env.MD2_EXPORT_TOKEN } });
    assert.equal(authorizedExport.status, 200);
  }
  console.log("round integration passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
