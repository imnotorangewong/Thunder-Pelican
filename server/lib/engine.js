'use strict';

/* 计分规则的服务端副本。
 *
 * 这份文件里的每个常数都必须和 index.html 的 ScoreEngine 完全一致 —— 服务端
 * 不重跑物理，只按同一套公式把事件日志重算一遍，再把「骑行速率」这一桶用速度
 * 轨迹围出一个上界。两边规则一旦分叉，审计会开始误杀，所以：
 *   改 index.html 的计分常数 → 同步改这里 → SCORE_ENGINE_VERSION 加一。
 * 客户端提交的 engine 字段必须等于本文件的版本号，否则直接拒收（历史成绩按当时
 * 的版本封存，不参与新版榜单）。
 */

const SCORE_ENGINE_VERSION = 3;

const STREAK_STEP = 20;
const STREAK_BUILD = 15;
const STREAK_CREEP = 0.01;
const HYPER_MARK_STEP = 10;
const STORM_BONUS_MULT = { C: 0.5, B: 0.7, A: 0.95, S: 1.25 };
const CONTRACT_BONUS = [0, 150, 300, 500];

/* FNV-1a 32 位：和客户端 ScoreEngine.fnv32 逐位一致 */
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hashLog(log) {
  return fnv32(log.join('|')).toString(16).padStart(8, '0');
}

/* 骑行基础分：每秒 3 * (speed/100)^2.2 */
function baseRate(speed) {
  return 3 * Math.pow(Math.max(0, Number(speed) || 0) / 100, 2.2);
}

/* 无伤乘区的绝对上界：把整局都算成无伤 */
function streakBound(elapsedSec) {
  const steps = Math.floor(Math.max(0, elapsedSec) / STREAK_STEP);
  const built = Math.min(steps, STREAK_BUILD);
  const crept = Math.max(0, steps - STREAK_BUILD);
  return 1 + built * 0.1 + crept * STREAK_CREEP;
}

function chainMult(chain) {
  return 1 + Math.min(Math.max(0, Number(chain) || 0), 24) * 0.04;
}

function hyperMult(speed, rated) {
  return speed > rated ? 1 + (speed - rated) / 28 : 1;
}

function strikeGain(chain) {
  return 5 * (1 + Math.min(Math.max(0, Number(chain) || 0), 24) * 0.08);
}

function breakGain(cap) {
  return 40 * (Math.max(0, Number(cap) || 0) / 132);
}

function calibrationGain(grade, chain) {
  const base = grade === 'perfect' ? 400 : grade === 'good' ? 150 : 0;
  return base * (1 + Math.min(Math.max(0, Number(chain) || 0), 8) * 0.25);
}

function stormGain(stormScore, mult) {
  return Math.round((Number(stormScore) || 0) * mult);
}

module.exports = {
  SCORE_ENGINE_VERSION,
  STREAK_STEP,
  STREAK_BUILD,
  STREAK_CREEP,
  HYPER_MARK_STEP,
  STORM_BONUS_MULT,
  CONTRACT_BONUS,
  fnv32,
  hashLog,
  baseRate,
  streakBound,
  chainMult,
  hyperMult,
  strikeGain,
  breakGain,
  calibrationGain,
  stormGain
};
