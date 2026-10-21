'use strict';

/* 榜单存储：一个进程内 Map + 一个 JSON 文件。
 *
 * 规则和客户端一致 —— 每个 owner 只留一条最佳成绩，新的只有在「分更高、或同分
 * 但峰速更高、或再同则更早」时才覆盖。榜单名次按全量记录排，不是只排前十。
 *
 * 单机 JSON 适合一个实例、几千个玩家；要横向扩到多实例或多机房，把这一层换成
 * Postgres（表结构见 DEPLOY-SERVER.md），其余代码不用动。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_OWNERS = 5000;
const SAVE_DEBOUNCE = 400;

function sortRows(rows) {
  return rows
    .slice()
    .sort((a, b) => (b.score - a.score) || (b.bestSpeed - a.bestSpeed) || (a.firstAt - b.firstAt));
}

function beats(candidate, held) {
  if (!held) return true;
  if (candidate.score !== held.score) return candidate.score > held.score;
  if (candidate.bestSpeed !== held.bestSpeed) return candidate.bestSpeed > held.bestSpeed;
  return false;
}

class BoardStore {
  constructor(file) {
    this.file = file;
    this.rows = new Map();
    this.updatedAt = 0;
    this.dirty = false;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      for (const row of data.rows || []) {
        if (!row || !row.ownerId || !row.id) continue;
        this.rows.set(String(row.ownerId), {
          id: String(row.id),
          ownerId: String(row.ownerId),
          name: String(row.name || 'GUEST').slice(0, 24),
          code: String(row.code || '#GUEST').slice(0, 12),
          score: Math.max(0, Math.round(Number(row.score) || 0)),
          bestSpeed: Math.round((Number(row.bestSpeed) || 0) * 10) / 10,
          durationSec: Math.max(0, Math.round(Number(row.durationSec) || 0)),
          endedBy: row.endedBy === 'wipeout' ? 'wipeout' : 'retired',
          endedAt: Math.max(0, Math.round(Number(row.endedAt) || 0)),
          verified: row.verified === true,
          firstAt: Math.max(0, Math.round(Number(row.firstAt) || Date.now())),
          updatedAt: Math.max(0, Math.round(Number(row.updatedAt) || Date.now())),
          runs: Math.max(1, Math.round(Number(row.runs) || 1))
        });
      }
      this.updatedAt = Math.max(0, Math.round(Number(data.updatedAt) || 0));
      return this;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        /* a corrupt file must not take the service down: keep a copy and start clean */
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await fsp.rename(this.file, backup).catch(() => {});
        console.error(`[store] ${this.file} 读不出来，已备份到 ${backup}`);
      }
      return this;
    }
  }

  get size() {
    return this.rows.size;
  }

  /* 收一条已通过审计的成绩；返回它在全量榜单上的位置 */
  submit(run) {
    const now = Date.now();
    const held = this.rows.get(run.ownerId) || null;
    const candidate = {
      id: run.id,
      ownerId: run.ownerId,
      name: run.name,
      code: run.code,
      score: run.score,
      bestSpeed: run.bestSpeed,
      durationSec: run.durationSec,
      endedBy: run.endedBy,
      endedAt: run.endedAt || now,
      verified: run.verified === true,
      firstAt: now,
      updatedAt: now,
      runs: (held ? held.runs : 0) + 1
    };

    let replaced = false;
    if (beats(candidate, held)) {
      candidate.firstAt = held ? held.firstAt : now;
      this.rows.set(candidate.ownerId, candidate);
      replaced = true;
    } else if (held) {
      held.runs += 1;
      held.updatedAt = now;
    }

    this.prune();
    this.updatedAt = now;
    this.schedule();
    return {
      accepted: true,
      replaced,
      rank: this.rankOf(run.ownerId),
      total: this.rows.size
    };
  }

  prune() {
    if (this.rows.size <= MAX_OWNERS) return;
    const keep = new Set(sortRows([...this.rows.values()]).slice(0, MAX_OWNERS).map((row) => row.ownerId));
    for (const key of [...this.rows.keys()]) if (!keep.has(key)) this.rows.delete(key);
  }

  rankOf(ownerId) {
    const sorted = sortRows([...this.rows.values()]);
    const index = sorted.findIndex((row) => row.ownerId === ownerId);
    return index < 0 ? null : index + 1;
  }

  /* 榜单只输出展示需要的字段：ownerId 不外传，you 由服务端算好 */
  top(limit, ownerId) {
    const sorted = sortRows([...this.rows.values()]).slice(0, Math.max(1, Math.min(100, limit)));
    return sorted.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      name: row.name,
      code: row.code,
      score: row.score,
      bestSpeed: row.bestSpeed,
      durationSec: row.durationSec,
      endedBy: row.endedBy,
      endedAt: row.endedAt,
      verified: row.verified,
      you: !!ownerId && row.ownerId === ownerId
    }));
  }

  schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.error('[store] 写盘失败', err));
    }, SAVE_DEBOUNCE);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload = JSON.stringify({
      version: 1,
      updatedAt: this.updatedAt,
      rows: sortRows([...this.rows.values()])
    });
    this.writing = this.writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fsp.writeFile(temp, payload, 'utf8');
      await fsp.rename(temp, this.file);
    });
    return this.writing;
  }
}

module.exports = { BoardStore, sortRows, MAX_OWNERS };
