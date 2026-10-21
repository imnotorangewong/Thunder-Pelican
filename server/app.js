'use strict';

/* Thunder Pelican 服务器：一个文件托管 + 两条排行榜接口，零依赖。
 *
 *   GET  /api/health                     存活探针
 *   GET  /api/leaderboard?limit=10&owner= 全球最佳成绩（每人一条）
 *   GET  /api/rank?owner=                某位骑手现在的名次
 *   POST /api/runs                       交一局成绩，先审计再入榜
 *
 * 环境变量见 DEPLOY-SERVER.md，全部有默认值，`node app.js` 就能起。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const E = require('./lib/engine');
const { auditRun } = require('./lib/audit');
const { BoardStore } = require('./lib/store');
const { securityHeaders, sendJson, corsHeaders, readJson, RateLimiter, clientIp, safeJoin, serveFile } = require('./lib/http');

const ROOT = path.resolve(__dirname, '..');

/* 页面的 meta 里如果填了一个绝对地址，CSP 的 connect-src 必须放行它，
   否则浏览器会把上传拦掉，而页面只会安静地退回本机模式——这种问题很难查。 */
function detectApiOrigin(staticDir) {
  try {
    const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
    const match = html.match(/<meta name="tp-leaderboard-api" content="([^"]*)"/);
    if (!match) return '';
    const raw = match[1].trim();
    if (!raw || raw.startsWith('/')) return '';
    return new URL(raw).origin;
  } catch (err) {
    return '';
  }
}

function loadConfig(overrides) {
  const env = process.env;
  const staticDir = path.resolve(ROOT, env.STATIC_DIR || '.');
  const cfg = {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 8787),
    staticDir,
    dataFile: path.resolve(__dirname, env.DATA_FILE || './data/board.json'),
    allowOrigin: env.ALLOW_ORIGIN === undefined ? '*' : env.ALLOW_ORIGIN,
    trustProxy: env.TRUST_PROXY === '1',
    auditStrict: env.AUDIT_STRICT !== '0',
    bodyLimit: Number(env.BODY_LIMIT || 1024 * 1024),
    cspConnect: [env.CSP_CONNECT || '', detectApiOrigin(staticDir)].filter(Boolean).join(' '),
    hsts: env.HSTS === '1',
    submitPerHour: Number(env.SUBMIT_PER_HOUR || 30),
    quiet: env.QUIET === '1'
  };
  return Object.assign(cfg, overrides || {});
}

function buildCsp(config) {
  const connect = ["'self'", config.cspConnect].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join('; ');
}

function createApp(options) {
  const config = loadConfig(options);
  const store = new BoardStore(config.dataFile);
  const startedAt = Date.now();
  const seenRuns = new Map(); /* runId → {rank,total,score}，防重放和重试重复计次 */

  const writeLimiter = new RateLimiter({ capacity: Math.max(3, Math.min(10, config.submitPerHour / 3)), refillPerSec: config.submitPerHour / 3600 });
  const readLimiter = new RateLimiter({ capacity: 60, refillPerSec: 2 });

  const ready = store.load();

  function cors(res, req) {
    const headers = corsHeaders(req.headers.origin, config.allowOrigin);
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }

  function log(req, res, status) {
    if (config.quiet) return;
    const ip = clientIp(req, config.trustProxy);
    console.log(`${new Date().toISOString()} ${status} ${req.method} ${req.url} ${ip}`);
  }

  async function handleApi(req, res, url) {
    const ip = clientIp(req, config.trustProxy);
    const pathname = url.pathname;
    const reading = req.method === 'GET' || req.method === 'HEAD';

    if (req.method === 'OPTIONS') {
      cors(res, req);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/api/health' && reading) {
      sendJson(res, 200, {
        ok: true,
        engine: E.SCORE_ENGINE_VERSION,
        total: store.size,
        updatedAt: store.updatedAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000)
      });
      return;
    }

    if (pathname === '/api/leaderboard' && reading) {
      if (!readLimiter.take(ip)) {
        sendJson(res, 429, { ok: false, reason: 'rate_limited' });
        return;
      }
      const limit = Number(url.searchParams.get('limit') || 10);
      const owner = String(url.searchParams.get('owner') || '').slice(0, 48);
      const myRank = owner ? store.rankOf(owner) : null;
      sendJson(res, 200, {
        ok: true,
        engine: E.SCORE_ENGINE_VERSION,
        total: store.size,
        updatedAt: store.updatedAt,
        /* 你自己的名次放在顶层：前二十里没有你的时候，页面照样知道自己是第几 */
        you: myRank ? { rank: myRank } : null,
        runs: store.top(Number.isFinite(limit) ? limit : 10, owner)
      });
      return;
    }

    if (pathname === '/api/rank' && reading) {
      if (!readLimiter.take(ip)) {
        sendJson(res, 429, { ok: false, reason: 'rate_limited' });
        return;
      }
      const owner = String(url.searchParams.get('owner') || '').slice(0, 48);
      const rank = owner ? store.rankOf(owner) : null;
      sendJson(res, 200, { ok: true, rank, total: store.size });
      return;
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      if (!writeLimiter.take(ip)) {
        sendJson(res, 429, { ok: false, accepted: false, reason: 'rate_limited' });
        return;
      }
      const body = await readJson(req, config.bodyLimit);
      if (!body.ok) {
        sendJson(res, 400, { ok: false, accepted: false, reason: body.error });
        return;
      }
      const payload = body.value || {};

      /* 同一条 run 重试（keepalive + 页面关闭）不该重复计次 */
      const previous = seenRuns.get(String(payload.id || ''));
      if (previous) {
        const owner = String(payload.ownerId || '');
        sendJson(res, 200, {
          ok: true,
          accepted: true,
          duplicate: true,
          verified: previous.verified,
          score: previous.score,
          rank: owner ? store.rankOf(owner) : null,
          total: store.size
        });
        return;
      }

      const verdict = auditRun(payload, { requireTrace: config.auditStrict });
      if (!verdict.ok) {
        sendJson(res, 422, {
          ok: false,
          accepted: false,
          verified: false,
          reason: verdict.reason,
          detail: verdict.detail || ''
        });
        return;
      }

      const scored = store.submit({
        id: String(payload.id),
        ownerId: String(payload.ownerId),
        name: String(payload.name).trim(),
        code: String(payload.code || '#GUEST').slice(0, 12),
        score: verdict.score,
        bestSpeed: Math.round((Number(payload.bestSpeed) || 0) * 10) / 10,
        durationSec: Math.round(Number(payload.durationSec) || 0),
        endedBy: payload.endedBy === 'wipeout' ? 'wipeout' : 'retired',
        endedAt: Number(payload.endedAt) || Date.now(),
        verified: verdict.verified
      });

      const result = {
        ok: true,
        accepted: true,
        verified: verdict.verified,
        reason: verdict.reason,
        rank: scored.rank,
        total: scored.total,
        replaced: scored.replaced,
        score: verdict.score
      };
      seenRuns.set(String(payload.id), { score: result.score, verified: result.verified });
      if (seenRuns.size > 20000) seenRuns.delete(seenRuns.keys().next().value);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'not_found' });
  }

  async function handler(req, res) {
    const started = Date.now();
    res.on('finish', () => log(req, res, `${res.statusCode} ${Date.now() - started}ms`));
    securityHeaders(res, { csp: buildCsp(config), hsts: config.hsts });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      sendJson(res, 400, { ok: false, reason: 'bad_url' });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      cors(res, req);
      try {
        await handleApi(req, res, url);
      } catch (err) {
        console.error('[api]', err);
        if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'server_error' });
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const clean = url.pathname === '/' ? '/index.html' : url.pathname;
    const allowed = clean === '/index.html' || clean.startsWith('/assets/');
    if (!allowed) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const filePath = safeJoin(config.staticDir, clean);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad path');
      return;
    }
    const cacheControl = clean === '/index.html'
      ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=86400';
    const served = await serveFile(req, res, filePath, { cacheControl });
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[server]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server error');
      } else {
        res.end();
      }
    });
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, config, store, ready };
}

async function start() {
  const app = createApp();
  await app.ready;
  await new Promise((resolve) => app.server.listen(app.config.port, app.config.host, resolve));
  const address = app.server.address();
  console.log(`thunder-pelican server on http://${app.config.host}:${address.port}`);
  console.log(`  static : ${app.config.staticDir}`);
  console.log(`  data   : ${app.config.dataFile}`);
  console.log(`  audit  : ${app.config.auditStrict ? 'strict' : 'lenient'}`);
  console.log(`  cors   : ${app.config.allowOrigin || 'same-origin only'}`);

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, flushing board...`);
    app.server.close();
    await app.store.flush().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, loadConfig };
