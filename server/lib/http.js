'use strict';

/* 这里只放和框架无关的小工具：JSON 收发、限流、静态文件。
 * 不引第三方依赖，是为了让 `node app.js` 在任何装了 Node 18+ 的机器上直接跑。 */

const fsp = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function securityHeaders(res, options) {
  const opts = options || {};
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (opts.csp) res.setHeader('Content-Security-Policy', opts.csp);
}

function sendJson(res, status, payload, extra) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, extra || {}));
  /* HEAD 只回头，不回体（探针常用 curl -I） */
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

function corsHeaders(origin, allowOrigin) {
  if (!allowOrigin) return {};
  const allow = allowOrigin === '*' ? '*' : allowOrigin.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

function readJson(req, limitBytes) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish({ ok: false, error: 'body_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return finish({ ok: false, error: 'empty_body' });
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (err) {
        finish({ ok: false, error: 'bad_json' });
      }
    });
    req.on('error', () => finish({ ok: false, error: 'read_error' }));
  });
}

/* 固定窗口 + 令牌桶的折中：每 IP 一个桶，按秒补充，突发量单独给额度 */
class RateLimiter {
  constructor(options) {
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
    this.buckets = new Map();
    this.sweep = setInterval(() => this.prune(), 60000);
    if (this.sweep.unref) this.sweep.unref();
  }

  take(key, cost) {
    const now = Date.now();
    const need = cost || 1;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSec);
    bucket.at = now;
    if (bucket.tokens < need) return false;
    bucket.tokens -= need;
    return true;
  }

  prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 10 * 60000) this.buckets.delete(key);
    }
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (err) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(root, '.' + path.posix.normalize(decoded));
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) return null;
  return resolved;
}

/* 2 MB 的 index.html 压完大约 1.5 MB，压一次缓存起来，按 mtime+size 失效 */
const gzipCache = new Map();

async function serveFile(req, res, filePath, options) {
  const opts = options || {};
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': opts.cacheControl || 'public, max-age=0, must-revalidate',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString()
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  // Audio players, including Safari, probe and seek using a single byte range.
  if (type === 'audio/mpeg') {
    headers['Accept-Ranges'] = 'bytes';
    let start = 0, end = stat.size - 1, status = 200;
    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2]) && !req.headers['if-range']) {
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) {
        res.writeHead(416, {...headers, 'Content-Range': 'bytes */' + stat.size});
        res.end();
        return true;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !stat.size) res.end();
    else {
      try { await pipeline(createReadStream(filePath, {start, end}), res); }
      catch (err) { if (!req.destroyed) throw err; }
    }
    return true;
  }

  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const compressible = /^(text\/|application\/(json|javascript))/.test(type);
  if (acceptsGzip && compressible && stat.size > 2048) {
    const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    let buf = gzipCache.get(key);
    if (!buf) {
      buf = await fsp.readFile(filePath).then((raw) => zlib.gzipSync(raw, { level: 6 }));
      if (gzipCache.size > 24) gzipCache.clear();
      gzipCache.set(key, buf);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = buf.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const raw = await fsp.readFile(filePath);
  res.end(raw);
  return true;
}

module.exports = {
  MIME,
  securityHeaders,
  sendJson,
  corsHeaders,
  readJson,
  RateLimiter,
  clientIp,
  safeJoin,
  serveFile
};
