'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp } = require('../app');
const { buildRun } = require('../testlib/run-builder');

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-board-'));
  const app = createApp({
    dataFile: path.join(dir, 'board.json'),
    port: 0,
    quiet: true,
    submitPerHour: 600,
    allowOrigin: '*'
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, dir };
}

async function stop(ctx) {
  await new Promise((resolve) => ctx.app.server.close(resolve));
  await ctx.app.store.flush();
  await fs.rm(ctx.dir, { recursive: true, force: true });
}

const post = (base, payload) => fetch(`${base}/api/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});

test('成绩入榜、同一个人只留最佳、榜单按全量排名', async (t) => {
  const ctx = await boot();
  t.after(() => stop(ctx));

  const health = await fetch(`${ctx.base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.total, 0);

  /* 第一条：新人第一 */
  const first = buildRun({ id: 'run_first_001', ownerId: 'rider:r_a', name: 'ALPHA' });
  const r1 = await post(ctx.base, first.payload).then((r) => r.json());
  assert.equal(r1.accepted, true, r1.reason);
  assert.equal(r1.rank, 1);
  assert.equal(r1.total, 1);

  /* 同一个人跑得更差：名次不动，记录不覆盖，局数 +1 */
  const worse = buildRun({ id: 'run_worse_002', ownerId: 'rider:r_a', name: 'ALPHA', speed: 70, strikeTimes: [] });
  assert.ok(worse.payload.score < first.payload.score);
  const r2 = await post(ctx.base, worse.payload).then((r) => r.json());
  assert.equal(r2.accepted, true, r2.reason);
  assert.equal(r2.replaced, false);
  assert.equal(r2.rank, 1);
  assert.equal(r2.total, 1);

  let board = await fetch(`${ctx.base}/api/leaderboard?limit=10&owner=${encodeURIComponent('rider:r_a')}`).then((r) => r.json());
  assert.equal(board.runs.length, 1);
  assert.equal(board.runs[0].score, first.payload.score, '差的一局不该顶掉最好的一局');
  assert.equal(board.runs[0].you, true);
  assert.equal(board.you.rank, 1);

  /* 还是这个人，跑出更高的分：覆盖成功 */
  const better = buildRun({ id: 'run_better_003', ownerId: 'rider:r_a', name: 'ALPHA', duration: 120, speed: 110 });
  assert.ok(better.payload.score > first.payload.score);
  const r3 = await post(ctx.base, better.payload).then((r) => r.json());
  assert.equal(r3.replaced, true);
  assert.equal(r3.rank, 1);
  assert.equal(r3.total, 1);

  /* 另一个人更高：两条记录，第二名是 ALPHA 的最佳成绩 */
  const rival = buildRun({ id: 'run_rival_004', ownerId: 'rider:r_b', name: 'BETA', duration: 180, speed: 130 });
  const r4 = await post(ctx.base, rival.payload).then((r) => r.json());
  assert.equal(r4.rank, 1);
  assert.equal(r4.total, 2);

  board = await fetch(`${ctx.base}/api/leaderboard?limit=10&owner=${encodeURIComponent('rider:r_a')}`).then((r) => r.json());
  assert.equal(board.total, 2);
  assert.equal(board.runs[0].name, 'BETA');
  assert.equal(board.runs[0].you, false);
  assert.equal(board.runs[1].name, 'ALPHA');
  assert.equal(board.runs[1].you, true);
  assert.equal(board.runs[1].score, better.payload.score);
  assert.equal(board.you.rank, 2, '前二十里没有你时，顶层 you 也要给出名次');

  const rank = await fetch(`${ctx.base}/api/rank?owner=${encodeURIComponent('rider:r_a')}`).then((r) => r.json());
  assert.equal(rank.rank, 2);

  /* 同一个 runId 重发（keepalive + 关页面重试）：不重复计次 */
  const replay = await post(ctx.base, better.payload).then((r) => r.json());
  assert.equal(replay.duplicate, true);
  assert.equal(replay.total, 2);
  board = await fetch(`${ctx.base}/api/leaderboard`).then((r) => r.json());
  assert.equal(board.runs.length, 2);
});

test('改过分的成绩进不了榜', async (t) => {
  const ctx = await boot();
  t.after(() => stop(ctx));

  const run = buildRun({ id: 'run_cheat_001', ownerId: 'rider:r_x', name: 'CHEAT' });
  run.payload.score += 100000;
  const res = await post(ctx.base, run.payload);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.accepted, false);
  assert.equal(body.reason, 'score_mismatch');

  const board = await fetch(`${ctx.base}/api/leaderboard`).then((r) => r.json());
  assert.equal(board.total, 0);
});

test('静态页面、缓存头和跨域头都在', async (t) => {
  const ctx = await boot();
  t.after(() => stop(ctx));

  const page = await fetch(`${ctx.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.ok(page.headers.get('etag'));
  const html = await page.text();
  assert.ok(html.includes('<title>Thunder Pelican'), '首页就是那个单文件游戏');

  const etag = page.headers.get('etag');
  const cached = await fetch(`${ctx.base}/`, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);

  const api = await fetch(`${ctx.base}/api/leaderboard`, { headers: { origin: 'https://example.com' } });
  assert.equal(api.headers.get('access-control-allow-origin'), '*');

  const missing = await fetch(`${ctx.base}/nope`);
  assert.equal(missing.status, 404);
});
