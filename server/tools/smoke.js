// 部署后的冒烟检查：只依赖 fetch，不需要装任何东西。
//   node tools/smoke.js https://pelican.example.com
// 退出码 0 = 全部通过，1 = 有检查不过。

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) failed += 1;
}
function note(name, detail) {
  console.log(`info ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
}

(async () => {
  /* 1. 首页可访问，而且是那个单文件游戏 */
  const page = await fetch(`${base}/`).catch((err) => ({ ok: false, status: 0, err }));
  if (!page.ok) {
    check('GET /', false, { status: page.status, error: String(page.err || '') });
  } else {
    const html = await page.text();
    check('GET /', html.includes('<title>Thunder Pelican'), { bytes: html.length });
    const meta = html.match(/<meta name="tp-leaderboard-api" content="([^"]*)"/);
    /* 同域部署应该填 /api；前端放在别处（GitHub Pages）时这里留空也正常 */
    note('页面里的服务器榜地址', { api: meta ? meta[1].trim() || '(空 = 纯本机模式)' : '(没有 meta)' });
    const etag = page.headers.get('etag');
    const cached = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });
    check('ETag 命中返回 304', cached.status === 304);
  }

  /* 2. 健康检查 */
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
  check('GET /api/health', !!health && health.ok === true, health);

  /* 3. 榜单接口的形状 */
  const board = await fetch(`${base}/api/leaderboard?limit=5`).then((r) => r.json()).catch(() => null);
  const shaped = !!board && board.ok === true && Array.isArray(board.runs)
    && board.runs.every((row) => typeof row.rank === 'number' && typeof row.name === 'string' && typeof row.score === 'number');
  check('GET /api/leaderboard', shaped, board && { total: board.total, rows: board.runs && board.runs.length });

  /* 4. 假成绩必须被拒 —— 这条最重要，说明审计是开着的 */
  const fake = {
    id: 'run_smoke_fake', ownerId: 'rider:smoke', name: 'SMOKE', engine: 3, startedAt: 0,
    durationSec: 60, bestSpeed: 120, score: 999999, endedBy: 'wipeout',
    breakdown: { rate: 999999 }, log: ['W@60.0:wipeout'], logHash: 'deadbeef', trace: [[0.25, 120]]
  };
  const rejected = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fake)
  });
  const verdict = await rejected.json().catch(() => null);
  check('改过分的成绩被拒', rejected.status >= 400 && verdict && verdict.accepted === false, verdict);

  /* 5. 跨域头（前端可能部署在 GitHub Pages 等另一个域） */
  const cors = await fetch(`${base}/api/health`, { headers: { origin: 'https://example.com' } });
  check('GET 带 CORS 头', !!cors.headers.get('access-control-allow-origin'), {
    origin: cors.headers.get('access-control-allow-origin')
  });

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
