'use strict';

/* 造一局「真骑出来的」成绩，供测试使用。
 * 数值全部走 lib/engine.js 的公式，所以它和客户端自洽：
 * 事件日志、速度轨迹、分桶、总分都能对上，除非测试故意改坏某一处。 */

const E = require('../lib/engine');

const round1 = (v) => Math.round(v * 10) / 10;

function buildRun(overrides = {}) {
  const startedAt = overrides.startedAt === undefined ? 120 : overrides.startedAt;
  const duration = overrides.duration === undefined ? 60 : overrides.duration;
  const rated = overrides.rated === undefined ? 166 : overrides.rated;
  const speed = overrides.speed === undefined ? 96 : overrides.speed;
  const chain = overrides.chain === undefined ? 0 : overrides.chain;
  const strikeTimes = overrides.strikeTimes || [4, 8, 12, 16, 20];
  const contractGain = overrides.contractGain || 150;
  const perfectChain = overrides.perfectChain === undefined ? 2 : overrides.perfectChain;

  const at = (t) => (startedAt + t).toFixed(1);
  const log = [];
  const trace = [];
  const breakdown = { rate: 0, strikes: 0, breaks: 0, hyper: 0, contract: 0, storm: 0, pressure: 0, calibration: 0 };

  let rawRate = 0;
  const step = 0.25;
  for (let t = 0; t < duration; t += step) {
    const dt = Math.min(step, duration - t);
    rawRate += E.baseRate(speed) * E.chainMult(chain) * E.streakBound(t + dt) * E.hyperMult(speed, rated) * dt;
    trace.push([round1(t + dt), round1(speed)]);
  }
  breakdown.rate = Math.round(rawRate);

  let rawStrikes = 0;
  for (const t of strikeTimes) {
    log.push(`S@${at(t)}:${chain}`);
    rawStrikes += E.strikeGain(chain);
  }
  breakdown.strikes = Math.round(rawStrikes);

  let rawCalibration = 0;
  if (overrides.calibration !== false) {
    log.push(`C@${at(duration * 0.4)}:perfect/${perfectChain}`);
    rawCalibration += E.calibrationGain('perfect', perfectChain);
  }
  breakdown.calibration = Math.round(rawCalibration);

  if (contractGain) {
    log.push(`Q@${at(duration * 0.5)}:hold/${contractGain}`);
    breakdown.contract = contractGain;
  }

  /* 每 2 秒一个 V 采样，和客户端 SCORE_LOG_SAMPLE 一致 */
  for (let t = 2; t < duration; t += 2) {
    log.push(`V@${at(t)}:${Math.round(speed)}/${chain}`);
  }
  log.push(`W@${at(duration)}:${overrides.endedBy || 'wipeout'}`);
  log.sort((a, b) => Number(a.split('@')[1].split(':')[0]) - Number(b.split('@')[1].split(':')[0]));

  const total = breakdown.rate + breakdown.strikes + breakdown.calibration + breakdown.contract;
  const payload = {
    id: overrides.id || 'run_test_abc123',
    ownerId: overrides.ownerId || 'rider:r_test_1',
    name: overrides.name || 'TEST RIDER',
    code: overrides.code || '#0001',
    engine: E.SCORE_ENGINE_VERSION,
    seed: 123456789,
    startedAt,
    rated,
    durationSec: duration,
    bestSpeed: round1(speed),
    distanceKm: round1((speed * duration) / 3600),
    streakBest: 1,
    endedBy: overrides.endedBy || 'wipeout',
    endedAt: 1700000000000,
    score: Math.round(total),
    breakdown,
    log,
    logHash: E.hashLog(log),
    trace,
    traceHash: E.fnv32(trace.map((p) => `${p[0]}:${p[1]}`).join('|')).toString(16).padStart(8, '0')
  };

  return { payload, log, trace, breakdown, raw: { rate: rawRate } };
}

module.exports = { buildRun, round1 };
