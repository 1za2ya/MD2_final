"use strict";

const crypto = require("crypto");

// 迷路とコイン数を一か所へ集約し、HUD・ログ・クリア判定で異なる値を使う事故を防ぐ。
const STAGES = Object.freeze({
  basic: {
    id: "basic", name: "Basic Research Stage", coinLayoutId: "basic_v1", start: [1, 1],
    maze: ["111111111","100000001","101110101","100010101","111010101","100010001","101111101","100000001","111111111"],
    coins: [[1,3],[1,7],[3,1],[3,5],[5,1],[5,7],[7,3],[7,7]]
  },
  forest: {
    id: "forest", name: "Branch Forest", coinLayoutId: "forest_v1", start: [1, 1],
    maze: ["111111111","100010001","101010101","101000101","101110101","100000101","101111101","100000001","111111111"],
    coins: [[1,3],[1,7],[3,3],[5,1],[5,5],[7,7]]
  },
  crossroads: {
    id: "crossroads", name: "Central Crossroads", coinLayoutId: "crossroads_v1", start: [1, 1],
    maze: ["111111111","100010001","101010101","100000001","110000011","100000001","101010101","100010001","111111111"],
    coins: [[1,3],[1,7],[2,1],[3,3],[3,7],[4,4],[5,1],[5,5],[7,3],[7,7]]
  },
  spiral: {
    id: "spiral", name: "Inner Spiral", coinLayoutId: "spiral_v1", start: [1, 1],
    maze: ["111111111","100000001","111111101","100000101","101110101","101000101","101011101","100000001","111111111"],
    coins: [[1,3],[1,7],[3,1],[3,5],[5,3],[7,1],[7,7]]
  },
  grid: {
    id: "grid", name: "Choice Grid", coinLayoutId: "grid_v1", start: [1, 1],
    maze: ["111111111","100000001","101010101","100000001","101010101","100000001","101010101","100000001","111111111"],
    coins: [[1,2],[1,6],[2,1],[2,5],[3,3],[3,7],[4,1],[4,5],[5,3],[5,7],[7,2],[7,6]]
  }
});

const ACCESS_CODES = Object.freeze({
  forest: process.env.MD2_STAGE_FOREST_CODE || "FOREST-XR",
  crossroads: process.env.MD2_STAGE_CROSSROADS_CODE || "CROSS-XR",
  spiral: process.env.MD2_STAGE_SPIRAL_CODE || "SPIRAL-XR",
  grid: process.env.MD2_STAGE_GRID_CODE || "GRID-XR"
});

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function toPublicStage(stage) {
  return {
    id: stage.id, name: stage.name, coinLayoutId: stage.coinLayoutId,
    start: [...stage.start], maze: [...stage.maze], coins: stage.coins.map((cell) => [...cell])
  };
}

function resolveStage(accessCode = "") {
  const normalizedCode = String(accessCode).trim().toUpperCase();
  if (!normalizedCode) return toPublicStage(STAGES.basic);
  const stageId = Object.keys(ACCESS_CODES).find((id) => safeEqual(normalizedCode, ACCESS_CODES[id].toUpperCase()));
  return stageId ? toPublicStage(STAGES[stageId]) : null;
}

function getStage(stageId) {
  return STAGES[stageId] ? toPublicStage(STAGES[stageId]) : null;
}

module.exports = { STAGES, resolveStage, getStage };
