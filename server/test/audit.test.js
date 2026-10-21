'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditRun } = require('../lib/audit');
const { buildRun } = require('../testlib/run-builder');
const E = require('../lib/engine');

test('一局正常成绩通过审计', () => {
  const { payload } = buildRun();
  const result = auditRun(payload);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.verified, true);
  assert.equal(result.score, payload.score);
});

test('开局一小时后才起跑，绝对时钟不影响判定', () => {
  const { payload } = buildRun({ startedAt: 3600, duration: 45 });
  const result = auditRun(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(payload.log[payload.log.length - 1].startsWith('W@3645.0'));
});

test('总分被改大，直接拒收', () => {
  const { payload } = buildRun();
  payload.score += 5000;
  const result = auditRun(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'score_mismatch');
});

test('改了日志但没重算指纹，hash 对不上', () => {
  const { payload } = buildRun();
  const index = payload.log.findIndex((line) => line.startsWith('S@'));
  payload.log[index] = payload.log[index].replace(/:(\d+)$/, ':24');
  const result = auditRun(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hash_mismatch');
});

test('改了日志并重算指纹，分桶对不上', () => {
  const { payload } = buildRun();
  const index = payload.log.findIndex((line) => line.startsWith('S@'));
  payload.log[index] = payload.log[index].replace(/:(\d+)$/, ':24');
  payload.logHash = E.hashLog(payload.log);
  const result = auditRun(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bucket_mismatch');
});

test('把速率桶灌水，会被速度上界拦下', () => {
  const { payload } = buildRun();
  payload.breakdown.rate *= 3;
  payload.score = payload.breakdown.rate + payload.breakdown.strikes + payload.breakdown.calibration + payload.breakdown.contract;
  const result = auditRun(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate_implausible');
});

test('没有速度轨迹时严格模式拒收、宽松模式降级', () => {
  const { payload } = buildRun();
  delete payload.trace;
  assert.equal(auditRun(payload).reason, 'no_trace');
  const lenient = auditRun(payload, { requireTrace: false });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.verified, false);
});

test('轨迹被改成更高的速度，峰速对不上', () => {
  const { payload } = buildRun();
  payload.trace = payload.trace.map((p) => [p[0], p[1] + 40]);
  payload.traceHash = E.fnv32(payload.trace.map((p) => `${p[0]}:${p[1]}`).join('|')).toString(16).padStart(8, '0');
  const result = auditRun(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'speed_mismatch');
});

test('计分引擎版本不一致的成绩不参与新版榜单', () => {
  const { payload } = buildRun();
  payload.engine = 2;
  assert.equal(auditRun(payload).reason, 'engine_mismatch');
});

test('太短的行程不收', () => {
  const { payload } = buildRun({ duration: 5, strikeTimes: [] });
  assert.equal(auditRun(payload).reason, 'too_short');
});

test('结尾事件缺失或原因不对，都不算完整一局', () => {
  const { payload } = buildRun();
  payload.log = payload.log.filter((line) => !line.startsWith('W@'));
  payload.logHash = E.hashLog(payload.log);
  assert.equal(auditRun(payload).reason, 'missing_end');

  const other = buildRun();
  other.payload.log[other.payload.log.length - 1] = `W@${(120 + 60).toFixed(1)}:gaveup`;
  other.payload.logHash = E.hashLog(other.payload.log);
  assert.equal(auditRun(other.payload).reason, 'bad_end_reason');
});

test('契约分只认档位表里的额度', () => {
  const { payload } = buildRun({ contractGain: 150 });
  const index = payload.log.findIndex((line) => line.startsWith('Q@'));
  payload.log[index] = payload.log[index].replace('/150', '/9000');
  payload.breakdown.contract = 9000;
  payload.score = payload.breakdown.rate + payload.breakdown.strikes + payload.breakdown.calibration + 9000;
  payload.logHash = E.hashLog(payload.log);
  assert.equal(auditRun(payload).reason, 'bad_event_value');
});
