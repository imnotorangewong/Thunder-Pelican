'use strict';

/* 成绩审计。
 *
 * 客户端交上来的东西只有三样：事件日志（log）、速度轨迹（trace）、以及自称的
 * 结算（score / breakdown）。服务端不跑物理，做的是三件事：
 *
 *   1. 指纹对得上 —— logHash 必须是这份日志的 FNV-1a，事件时间单调、结尾是 W。
 *   2. 离散分能重算 —— 闪电、突破、超频档、冲刺、契约、脱困、校准这七桶全部按
 *      公式重算，允许浮点取整的误差，多报一分都不行。
 *   3. 连续分有上界 —— 骑行速率这一桶用速度轨迹围出一个上界：每段取两端较大
 *      速度、最大雷链、以及「全程无伤」的乘区，再按段长给一点余量。真骑出来的
 *      分一定在上界以内，凭空多报的分会掉出去。
 *
 * 这里挡的是改包、改分、伪造结算这类粗糙作弊；全程伪造一条自洽的轨迹仍然能过，
 * 那需要服务端权威模拟（客户端只发输入、物理在服务端跑）。这条边界写在
 * DEPLOY-SERVER.md 里，别把这里的 verified 当成「绝对真实」。
 */

const E = require('./engine');

const LIMITS = {
  maxLog: 2400,
  maxTrace: 4000,
  minDuration: 8,
  maxDuration: 6 * 3600,
  minScore: 60,
  maxScore: 5000000,
  maxSpeed: 600,
  rateSlack: 1.05,
  rateFlat: 30,
  bucketTolerance: 1
};

const END_REASONS = new Set(['wipeout', 'retired', 'switch', 'checkin']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fail = (reason, detail) => ({ ok: false, verified: false, reason, detail: detail || '' });

function parseLog(log) {
  const events = [];
  for (const raw of log) {
    if (typeof raw !== 'string' || raw.length > 96) return { error: 'bad_event' };
    const at = raw.indexOf('@');
    if (at < 1) return { error: 'bad_event' };
    const code = raw.slice(0, at);
    if (code.length !== 1) return { error: 'bad_event' };
    const rest = raw.slice(at + 1);
    const colon = rest.indexOf(':');
    const t = Number(colon < 0 ? rest : rest.slice(0, colon));
    if (!Number.isFinite(t) || t < 0) return { error: 'bad_event_time' };
    events.push({ code, t, value: colon < 0 ? '' : rest.slice(colon + 1) });
  }
  return { events };
}

/* 速度轨迹围出的速率上界；任何真实骑行都不可能超过它 */
function rateEnvelope(trace, duration, chainPeak, rated) {
  if (!trace.length) return 0;
  const points = trace.slice();
  if (points[0].t > 0) points.unshift({ t: 0, v: points[0].v });
  let upper = 0;
  for (let i = 0; i < points.length; i += 1) {
    const t0 = points[i].t;
    const t1 = i + 1 < points.length ? points[i + 1].t : duration;
    const span = t1 - t0;
    if (!(span > 0)) continue;
    const peak = Math.max(points[i].v, i + 1 < points.length ? points[i + 1].v : points[i].v);
    /* 采样越稀，越可能漏掉一段加速，余量按段长放大 */
    const slack = 1 + Math.min(0.5, 0.06 * Math.max(0, span - 0.25));
    const mult = E.chainMult(chainPeak) * E.streakBound(t1) * E.hyperMult(peak, rated);
    upper += E.baseRate(peak) * mult * span * slack;
  }
  return upper;
}

function normalizeTrace(trace) {
  if (!Array.isArray(trace)) return { error: 'bad_trace' };
  const out = [];
  let previous = -1;
  for (const point of trace) {
    if (!Array.isArray(point) || point.length < 2) return { error: 'bad_trace' };
    const t = Number(point[0]);
    const v = Number(point[1]);
    if (!Number.isFinite(t) || !Number.isFinite(v)) return { error: 'bad_trace' };
    if (t < 0 || v < 0 || v > LIMITS.maxSpeed) return { error: 'bad_trace_speed' };
    if (t < previous) return { error: 'trace_out_of_order' };
    if (t === previous) continue;
    previous = t;
    out.push({ t, v });
  }
  return { trace: out };
}

function auditRun(payload, options) {
  const opts = Object.assign({ requireTrace: true }, options || {});
  if (!payload || typeof payload !== 'object') return fail('bad_payload');

  const engine = Number(payload.engine);
  if (engine !== E.SCORE_ENGINE_VERSION) {
    return fail('engine_mismatch', `engine ${engine} != ${E.SCORE_ENGINE_VERSION}`);
  }
  const score = Number(payload.score);
  const duration = Number(payload.durationSec);
  const bestSpeed = Number(payload.bestSpeed);
  if (!isNum(score) || !isNum(duration) || !isNum(bestSpeed)) return fail('bad_payload');
  if (duration < LIMITS.minDuration) return fail('too_short', `duration ${duration}`);
  if (duration > LIMITS.maxDuration) return fail('too_long');
  if (score < LIMITS.minScore) return fail('score_too_low');
  if (score > LIMITS.maxScore) return fail('score_too_high');
  if (bestSpeed > LIMITS.maxSpeed) return fail('speed_implausible');

  const id = String(payload.id || '');
  const ownerId = String(payload.ownerId || '');
  const name = String(payload.name || '').trim();
  if (!/^[A-Za-z0-9_:-]{6,48}$/.test(id)) return fail('bad_id');
  if (!/^[A-Za-z0-9_:-]{4,48}$/.test(ownerId)) return fail('bad_owner');
  if (!name || name.length > 24) return fail('bad_name');

  const board = payload.breakdown;
  if (!board || typeof board !== 'object') return fail('bad_breakdown');
  const claimed = {
    rate: Number(board.rate) || 0,
    strikes: Number(board.strikes) || 0,
    breaks: Number(board.breaks) || 0,
    hyper: Number(board.hyper) || 0,
    contract: Number(board.contract) || 0,
    storm: Number(board.storm) || 0,
    pressure: Number(board.pressure) || 0,
    calibration: Number(board.calibration) || 0
  };
  for (const key of Object.keys(claimed)) {
    if (claimed[key] < 0 || claimed[key] > LIMITS.maxScore) return fail('bad_breakdown', key);
  }

  const log = payload.log;
  if (!Array.isArray(log) || !log.length) return fail('no_log');
  if (log.length > LIMITS.maxLog) return fail('log_too_long');
  const parsed = parseLog(log);
  if (parsed.error) return fail(parsed.error);
  const events = parsed.events;

  const claimedHash = String(payload.logHash || '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(claimedHash)) return fail('bad_hash');
  const realHash = E.hashLog(log);
  if (realHash !== claimedHash) return fail('hash_mismatch', `${realHash} != ${claimedHash}`);

  let previous = -1;
  for (const event of events) {
    if (event.t < previous) return fail('log_out_of_order');
    previous = event.t;
  }
  const last = events[events.length - 1];
  if (last.code !== 'W') return fail('missing_end');
  if (!END_REASONS.has(last.value)) return fail('bad_end_reason', last.value);
  if (payload.endedBy && payload.endedBy !== last.value) return fail('end_mismatch');
  /* 事件时间是页面内的游戏时钟（从打开页面算），先换成「本局第几秒」再比时长 */
  const startedAt = Number(payload.startedAt) || 0;
  const lastRel = last.t - startedAt;
  if (startedAt < 0 || lastRel < -1 || lastRel > duration + 1.5) return fail('duration_mismatch');

  /* ---- 离散桶：按公式逐个重算 ---- */
  const computed = { strikes: 0, breaks: 0, hyper: 0, storm: 0, pressure: 0, contract: 0, calibration: 0 };
  let chainPeak = 0;
  let maxCap = 0;
  let rEvents = 0;

  for (const event of events) {
    switch (event.code) {
      case 'S': {
        const chain = Number(event.value) || 0;
        if (chain < 0 || chain > 96) return fail('bad_event_value', 'S');
        chainPeak = Math.max(chainPeak, chain);
        computed.strikes += E.strikeGain(chain);
        break;
      }
      case 'V': {
        const [speedText, chainText] = String(event.value).split('/');
        const speed = Number(speedText);
        const chain = Number(chainText) || 0;
        if (!Number.isFinite(speed) || speed < 0 || speed > LIMITS.maxSpeed) return fail('bad_event_value', 'V');
        chainPeak = Math.max(chainPeak, chain);
        break;
      }
      case 'B': {
        const cap = Number(event.value);
        if (!Number.isFinite(cap) || cap < 0 || cap > 400) return fail('bad_event_value', 'B');
        maxCap = Math.max(maxCap, cap);
        computed.breaks += E.breakGain(cap);
        break;
      }
      case 'H':
        computed.hyper += 50;
        break;
      case 'R': {
        const [rawScore, rawMult] = String(event.value).split('/');
        const stormScore = Number(rawScore);
        const mult = Number(rawMult);
        if (!Number.isFinite(stormScore) || !Number.isFinite(mult)) return fail('bad_event_value', 'R');
        if (!Object.values(E.STORM_BONUS_MULT).includes(mult)) return fail('bad_event_value', 'R mult');
        rEvents += 1;
        computed.storm += E.stormGain(stormScore, mult);
        break;
      }
      case 'P':
        computed.pressure += 300;
        break;
      case 'Q': {
        const [contractId, rawGain] = String(event.value).split('/');
        const gain = Number(rawGain);
        if (!contractId || !Number.isFinite(gain) || !E.CONTRACT_BONUS.includes(gain)) {
          return fail('bad_event_value', 'Q');
        }
        computed.contract += gain;
        break;
      }
      case 'C': {
        const [grade, rawChain] = String(event.value).split('/');
        const chain = Number(rawChain);
        if (!['perfect', 'good', 'miss'].includes(grade) || !Number.isFinite(chain)) {
          return fail('bad_event_value', 'C');
        }
        computed.calibration += E.calibrationGain(grade, chain);
        break;
      }
      case 'A':
      case 'W':
        break;
      default:
        return fail('unknown_event', event.code);
    }
  }

  /* 每桶允许取整误差；冲刺那一桶客户端日志里存的是整数分，多给一点余量 */
  const toleranceFor = (key) => LIMITS.bucketTolerance + (key === 'storm' ? rEvents * 0.6 : 0);
  for (const key of Object.keys(computed)) {
    const diff = Math.abs(claimed[key] - computed[key]);
    if (diff > toleranceFor(key) + claimed[key] * 0.002) {
      return fail('bucket_mismatch', `${key} claimed ${Math.round(claimed[key])} vs ${Math.round(computed[key])}`);
    }
  }

  /* ---- 连续桶：速度轨迹围上界 ---- */
  if (!Array.isArray(payload.trace) || !payload.trace.length) {
    if (opts.requireTrace) return fail('no_trace');
    /* 没有轨迹只能收下离散分，速率桶按低可信度记 */
    const partial = Object.assign({}, computed, { rate: 0 });
    return {
      ok: true,
      verified: false,
      reason: 'no_trace',
      score: Math.round(Object.values(partial).reduce((a, b) => a + b, 0)),
      breakdown: partial,
      claimed
    };
  }
  const normalized = normalizeTrace(payload.trace);
  if (normalized.error) return fail(normalized.error);
  const trace = normalized.trace;

  const traceHash = String(payload.traceHash || '').toLowerCase();
  /* 指纹按「客户端发来的原样」算，去重后的轨迹只用于围上界 */
  const realTraceHash = E.fnv32(payload.trace.map((p) => `${Number(p[0])}:${Number(p[1])}`).join('|'))
    .toString(16).padStart(8, '0');
  if (traceHash && traceHash !== realTraceHash) return fail('trace_hash_mismatch');

  const traceDuration = trace[trace.length - 1].t;
  if (traceDuration < duration * 0.8) return fail('trace_too_short', `${traceDuration} vs ${duration}`);
  const tracePeak = trace.reduce((max, p) => Math.max(max, p.v), 0);
  if (Math.abs(tracePeak - bestSpeed) > 2.5) {
    return fail('speed_mismatch', `trace ${tracePeak.toFixed(1)} vs claimed ${bestSpeed.toFixed(1)}`);
  }

  /* 氮气上限由完美校准次数与 CPS 决定，不再代表骑手等级。
     用最低额定值 166 计算超频乘区，给速率桶留出保守上界，避免高氮气速度被误拒。 */
  const rated = 166;
  const envelope = rateEnvelope(trace, duration, chainPeak, rated);
  const allowance = envelope * LIMITS.rateSlack + LIMITS.rateFlat;
  if (claimed.rate > allowance) {
    return fail('rate_implausible', `rate ${Math.round(claimed.rate)} > ${Math.round(allowance)}`);
  }

  /* ---- 总分必须等于各桶之和 ---- */
  const total = Object.values(claimed).reduce((a, b) => a + b, 0);
  if (Math.abs(score - total) > 8) {
    return fail('score_mismatch', `score ${score} vs buckets ${Math.round(total)}`);
  }

  /* 入库用客户端自报的总分：它和各桶之和的差已经被上面那条 ±8 卡死了，
     这样榜单上的数字和玩家结算卡上看到的完全一致（逐桶取整会有 1–2 分的漂移）。
     recomputed 留着做审计记录。 */
  return {
    ok: true,
    verified: true,
    reason: 'ok',
    score: Math.round(score),
    recomputed: Math.round(total),
    breakdown: claimed,
    envelope: Math.round(envelope),
    tracePoints: trace.length
  };
}

module.exports = { auditRun, LIMITS, rateEnvelope };
