# 部署到服务器

这一版**没有本机榜**：排行榜只有一份，在服务器上。所以「要不要排行榜」等于「要不要部署 `server/`」。

- 只想发个静态页、不要排名 → 看 [DEPLOY.md](DEPLOY.md)，`index.html` 里那个 meta 留空，页面上不会有任何榜。
- 想要排行榜 → 从这里开始，一套服务端 + 五种部署方式。

> **拿到的是压缩包？** 解压后三段：改 `index.html` 里的 meta 填 `/api`；
> 想用 Docker 就 `cd server/deploy && docker compose up -d --build`；
> 不想用 Docker 就 `cd server && node app.js`（Node 18+，零依赖，默认 8787 端口）。

---

## 一、五种方案，先挑一个

| 方案 | 需要什么 | 上手 | 费用（量级） | HTTPS | 适合 |
| --- | --- | --- | --- | --- | --- |
| **A. 单机 Docker + Caddy** | 一台 1C1G VPS、一个域名 | 10 分钟 | $4–6/月 | Caddy 自动 | **推荐**，省心 |
| **B. systemd + Nginx** | 同上，不用 Docker | 30 分钟 | $4–6/月 | certbot | 想完全掌控机器 |
| **C. Fly.io / Railway / Render** | 一个账号 | 10 分钟 | 按用量，几美元起 | 平台自带 | 不想碰服务器 |
| **D. 静态前端 + 独立 API** | Pages/CDN + 一台小机器 | 20 分钟 | 静态免费 + $4/月 | 两边各自解决 | 前端要放 CDN |
| **E. Cloudflare Workers + D1** | 一个 Cloudflare 账号 | 1–2 小时 | 免费额度够用 | 自带 | 想零运维、按量付费 |

> 一台 1C1G 的机器足够撑到几千人：榜单常驻内存几百 KB，瓶颈永远是首屏那 1.29 MiB（gzip 后）。
> 具体的内存 / 磁盘 / 带宽怎么算，见下一节（都是实测）。
> 国内机房需要备案，海外机房（香港、新加坡、日本）不用，延迟通常也在可接受范围。

下面每一套都能直接复制命令。所有方案最后都做同一件事：**把 `index.html` 里的 meta 指向接口**。

```html
<meta name="tp-leaderboard-api" content="/api" />
```

---

## 二、要多大机器（实测口径）

结论先给：

| 规模 | 机器 | 进程内存 | 磁盘 | 带宽 | 月费量级 |
| --- | --- | --- | --- | --- | --- |
| 熟人局（< 100 人） | 1 vCPU / 512 MB / 10 GB | 60–80 MB | < 100 MB | 100 Mbps | $3–4 |
| 小公测（约 1000 人） | 1 vCPU / 1 GB / 20 GB | 80–110 MB | < 200 MB | 1 Gbps 或 CDN | $5–10 |
| 上万（1 万人） | 2 vCPU / 1 GB / 40 GB | 90–130 MB | < 500 MB | 必须 CDN | $10–20 |
| 十万+ | 换 Postgres + 多实例 | 见下 | — | CDN | — |

为什么这么小：这个服务只做两件事——发一个静态文件、维护一张很小的表。没有数据库查询，没有图片，
没有后台任务。

### 实测数字

在开发机上量出来的（`index.html` 2.18 MB、榜单 100–100000 条都跑过），不是拍脑袋：

| 项 | 数字 |
| --- | --- |
| `index.html` | 2.08 MiB；gzip 1.29 MiB；brotli 1.25 MiB |
| 一局上传包 | 上限 **37 KB**（720 条事件 + 2000 个速度点），gzip 11.7 KB；审计完就丢，不落盘 |
| 单次审计耗时 | **2.1 ms**（802 事件 + 4800 点；真实上限更小）→ 单核约 480 次/秒 |
| 榜单一条（磁盘） | **250 B** |
| 榜单一条（内存） | 约 **1.2 KB**（JS 对象开销比 JSON 大） |
| 空进程 RSS | **41 MB** |
| 压测中 RSS | **62 MB** |
| `GET /`（gzip） | 299 req/s、384 MiB/s（本机 loopback + keep-alive） |
| `GET /api/leaderboard` | 4,717 req/s |

### 内存怎么算

```text
RSS ≈ 41 MB（Node 运行时）
    + 1.2 KB × 榜上人数
    + 1.3 MB（gzip 后的首页缓存，压一次一直用）
    + 并发缓冲（每个在途请求几十 KB）
```

- 1000 人：41 + 1.2 + 1.3 ≈ 44 MB，实际跑起来 60–80 MB，**512 MB 的机器够用**。
- 5000 人（默认上限）：再加 6 MB，50 MB 上下。
- 10 万人：实测 162 MB，单进程仍能跑，但会撞上下面的写盘问题。

`server/lib/store.js` 里 `MAX_OWNERS = 5000` 是硬上限，超了按分数从低到高淘汰。
要放开就改这个数（同时想清楚写盘和备份）。

### 存储怎么算

- **榜单**：每人一行 250 B。5000 人 ≈ **1.25 MB**，而且**不随局数增长**（每人只留最佳一局）。
- **不存每局流水**：37 KB 的成绩包只在审计时存在内存里，入榜后丢掉。磁盘基本上是平的。
  以后想留流水（复议、回放）再加 `run_log` 表：1 万局/天 × 37 KB ≈ **370 MB/天**，得配归档。
- **访问日志**：一行约 200 B，1 万请求/天 ≈ 2 MB/天；`QUIET=1` 可以关。
- **系统 + 镜像**：Node 22 + 代码 + 基础镜像，约 **200 MB**。

所以 10 GB 的盘能用很多年，瓶颈从来不是磁盘。

### 带宽怎么算

首访要下 1.29 MiB；回访走 `ETag` → **304**，只花几百字节（页面设的是 `must-revalidate`，不会拿到旧版本）。

- 1000 个新玩家/天 ≈ **1.3 GB/天 ≈ 39 GB/月**。
- 100 Mbps：12.5 MB/s ÷ 1.29 MB ≈ **9.7 个首访/秒**，够几百人同时涌进来。
- 1 Gbps：约 97 个首访/秒。

> 这 1.29 MiB 的 gzip 是命门。确认反代没把 `Accept-Encoding` 剥掉，否则每次首访 2.08 MiB，
> 流量直接多 60%。`curl -sI https://你的域名/ | grep -i content-encoding` 看一眼。

### 国内买机器：先算带宽，再挑配置

国内轻量服务器标的「3M / 4M / 6M」是**峰值带宽**，不是不限速。拿这个游戏算：

| 峰值带宽 | 下行速度 | 首访 1.29 MiB 要多久 | 大约每几秒能接一个首访 |
| --- | --- | --- | --- |
| 3 Mbps | 375 KB/s | **3.5 秒** | 3.4 秒 |
| 4 Mbps | 500 KB/s | **2.7 秒** | 2.7 秒 |
| 5 Mbps | 625 KB/s | 2.1 秒 | 2.1 秒 |
| 6 Mbps | 750 KB/s | 1.7 秒 | 1.7 秒 |
| 30 Mbps（香港轻量常见） | 3.75 MB/s | 0.35 秒 | 0.35 秒 |

> **别买 3M 以下的套餐。** 3–5 个人同时点开，3M 的机器会让人干等十几秒；
> 换 6M 也只是「能忍」。游戏入口 `index.html` 约 2.08 MB，13 款骑手插画则按需单独下载，带宽比 CPU 重要得多。
> 并发是平分的：4M 的机器上 N 个人同时点开，每个人大约等 `N × 2.7` 秒。

**带宽紧的话，有一招比升配更管用**：首屏 1.29 MiB 里，**1.04 MiB 是背景音乐**（base64 内嵌，
AAC 压不动）。把音乐拆成外部文件、改成按需加载，首屏只剩 **0.27 MiB**——4M 的机器也能 0.55 秒开屏，
音乐在第一次点击后后台下载，不挡游戏。代价是从「一个文件」变成「index.html + 一个音频文件」，
双击一起放在同一目录照样能跑。

三个现实选择：

1. **香港 / 新加坡轻量**（不用备案）：2 核 2G、30M 峰值、1 TB 月流量，活动价常年 ¥99–288/年。
   这游戏不是实时对战，30–60 ms 的延迟完全无感，**部署最省事**，首屏还快。
2. **国内轻量 + ICP 备案**：2 核 2G / 6M 起，预算够就 2 核 4G / 8M。
   备案 7–20 个工作日，个人备案要身份证 + 真实性核验，部分省份还要居住证；
   备案下来之前域名不能走 80/443。
3. **高带宽的轻量 / CVM**：峰值能开到 100–200 Mbps。计费口径有两种，名字很像、差别很大，
   下单前一定看清：
   - **不限量**：写「无固定流量，流量可无限使用，不会产生超额流量费用」。
     200 Mbps 拉满也不加钱，**这个项目最理想**。
   - **按量**：写「¥0.8/GB」之类。1000 个首访 ≈ 1.35 GB ≈ ¥1，1 万个 ≈ ¥11，量小可以忽略，
     但必须开流量封顶（见下）。

> **按量计费必须开流量封顶。** 200 Mbps 被刷满一小时就是 90 GB，按 ¥0.8/GB 算约 **¥72/小时**——
> 不是被黑，是账单炸了。腾讯云轻量有「流量封顶」开关，阿里云可以用「节省停机」+ 费用告警，
> 小厂多半没有，那就自己用 Caddy/Nginx 限速 + fail2ban。
> **不限量**的套餐没有这个问题；固定带宽 + 流量包的套餐也没有，超了只是限速。

买之前去官网活动页对一下当天的价（活动几乎每月变）：阿里云「轻量应用服务器」、腾讯云「轻量应用服务器」、
华为云 / 京东云同类产品；有学生认证通常还有一档更便宜的。配置按上面的结论挑就行——
**1 vCPU / 1 GB 是下限，2 核 2G 是甜点，磁盘 40 GB 用十年都填不满。**

### 国内上线：备案是唯一的卡点

**买之前先确认厂商能不能备案。** 只有具备 IDC/ISP 资质、自带备案系统的云厂商（阿里云、腾讯云、
华为云这类）才能代办；很多便宜的小厂根本没有备案通道，机器买了也挂不上域名——这是最容易踩的坑。

备案清单：

| 项 | 说明 |
| --- | --- |
| 接入商 | 域名和服务器最好在同一家；跨厂商要做「接入」变更 |
| 主体 | 个人：身份证、手机号、邮箱、人脸核验 |
| 域名 | 必须完成实名认证（.com/.cn 均可），且未过期 |
| 服务器 | 购买时长一般要求 ≥ 3 个月，年付满足；有的还要「备案授权码」 |
| 时间 | 7–20 个工作日（各省不同）；通过后 30 日内再做公安联网备案 |
| 费用 | 备案本身免费，域名约 ¥30–60/年 |
| 网站名称 | 个人备案别写「游戏」「在线游戏」，写「个人作品展示」这类更稳 |
| 内容 | 公开运营、收费的游戏需要版号/文网文，个人办不了；自己玩的小作品按作品展示报即可 |

**备案期间怎么跑**：部署照做，用 `http://服务器IP:8787` 自测（多数机房只拦未备案域名的 80/443，
非标端口一般能用，但不合规，只适合自测）；域名先不解析。备案通过后再切 80/443，
Caddy 那一刻才会去申证书。

> **续费价要看清。** 「¥68/年」几乎都是新用户首年特惠，续费常见 ¥300–600/年。
> 打算长期挂着就一次买 2–3 年，或者到期前提前比价。

### 什么时候该动配置

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| CPU 打满 | 静态页在重复压缩，或访问日志写太勤 | 确认 gzip 缓存生效、开 `QUIET=1` |
| 内存慢慢涨 | 榜上人数 × 1.2 KB；超过 5000 是 `MAX_OWNERS` 在淘汰 | 不是泄漏，调上限或换库 |
| 提交变慢 | JSON 每次变更全量重写文件：5000 行 1.25 MB 没问题，10 万行 25 MB 就慢了 | 换 Postgres |
| 想加实例 | JSON 是进程内 Map，两个实例各写各的 | **不要直接横向扩**，先换库 |
| 首屏慢 | 1.29 MiB 的下行 | 上 CDN / 降音乐码率 |

## 三、方案 A：单机 Docker + Caddy（推荐）

`server/deploy/` 里已经写好 `docker-compose.yml` 和 `Caddyfile`：游戏和 Caddy 两个容器，
Caddy 自动申请证书、自动续期。

```bash
git clone <your-repo> thunder-pelican && cd thunder-pelican

# 1. 页面指向同域接口
sed -i 's#<meta name="tp-leaderboard-api" content="" />#<meta name="tp-leaderboard-api" content="/api" />#' index.html

# 2. 换成自己的域名
sed -i 's/pelican.example.com/你的域名/' server/deploy/Caddyfile

# 3. 起
cd server/deploy
docker compose up -d --build

# 4. 自检
cd ../.. && node server/tools/smoke.js https://你的域名
```

数据在名为 `board` 的 volume 里（`/data/board.json`）。备份：

```bash
docker run --rm -v deploy_board:/data -v "$PWD:/backup" alpine \
  sh -c "cp /data/board.json /backup/board-$(date +%F).json"
```

想加访问频率限制，把 Caddy 换成 Nginx（方案 B 的配置），或者直接依赖服务端自带的令牌桶——它已经在限了。

---

## 四、方案 B：systemd + Nginx（不用 Docker）

```bash
# 1. 用户与目录
sudo useradd --system --home /srv/thunder-pelican --shell /usr/sbin/nologin thunderpelican
sudo mkdir -p /srv/thunder-pelican/server/data
sudo chown -R thunderpelican:thunderpelican /srv/thunder-pelican

# 2. 代码（meta 记得填 /api）
sudo rsync -a --delete ./ /srv/thunder-pelican/

# 3. 环境变量
sudo tee /etc/thunder-pelican.env >/dev/null <<'EOF'
PORT=8787
HOST=127.0.0.1
STATIC_DIR=/srv/thunder-pelican
DATA_FILE=/srv/thunder-pelican/server/data/board.json
ALLOW_ORIGIN=https://你的域名
TRUST_PROXY=1
HSTS=1
EOF
sudo chmod 640 /etc/thunder-pelican.env
sudo chown root:thunderpelican /etc/thunder-pelican.env

# 4. 服务
sudo cp server/deploy/thunder-pelican.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thunder-pelican
curl -s http://127.0.0.1:8787/api/health

# 5. Nginx + 证书
sudo cp server/deploy/nginx.conf /etc/nginx/sites-available/thunder-pelican
sudo sed -i 's/pelican.example.com/你的域名/g' /etc/nginx/sites-available/thunder-pelican
sudo ln -s /etc/nginx/sites-available/thunder-pelican /etc/nginx/sites-enabled/
sudo certbot --nginx -d 你的域名
sudo nginx -t && sudo systemctl reload nginx
```

> `HOST=127.0.0.1` 只让 Nginx 进来；`TRUST_PROXY=1` 让它从 `X-Forwarded-For` 取真实 IP，
> 限流才不会变成「全世界共用一个桶」。

---

## 五、方案 C：PaaS（Fly.io / Railway / Render）

以 Fly.io 为例，`server/deploy/fly.toml` 已经写好（香港区域、256 MB、带持久卷）：

```bash
fly launch --no-deploy --copy-config --name thunder-pelican
fly volumes create tp_board --size 1 --region hkg
fly deploy
fly open
```

要点：

- **只能跑一台机器**。榜单是进程内的 JSON 文件，`fly scale count 2` 会变成两份互不相干的榜。
- 冷启动：`auto_stop_machines = "suspend"` 省钱，但闲置后第一次访问要等一两秒。
- 卷要备份：`fly ssh console -C "cat /data/board.json" > board-$(date +%F).json`。
- 换成 Railway / Render 时同理，关键是「持久磁盘 + 单实例 + `PORT` 环境变量」。

---

## 六、方案 D：静态前端 + 独立 API

游戏放 GitHub Pages / Cloudflare Pages（首屏走 CDN），接口单独一台机器。

```html
<!-- index.html：填绝对地址 -->
<meta name="tp-leaderboard-api" content="https://api.example.com/api" />
```

服务端要多做两件事：

```bash
ALLOW_ORIGIN=https://your-name.github.io     # 放行页面来源，逗号分隔多个
CSP_CONNECT=https://api.example.com          # 让页面允许连这个域
```

> `CSP_CONNECT` 其实可以省：服务端启动时会读 `index.html` 里的 meta，绝对地址的 origin
> 会自动加进 `connect-src`。显式写上只是更保险。

Pages 的工作流会发布 `index.html` 和 `assets/skins/`，所以 meta 改完推一次就生效。前后端分属两个域时，
记得把 `ALLOW_ORIGIN` 收紧到自己的页面域名，别留 `*`。

---

## 七、方案 E：Cloudflare Workers + D1（要改存储层）

服务端的业务代码是纯 JS，能直接跑在 Workers 上；要换掉的只有两处：

1. `lib/store.js` → 换成 D1（或 KV）实现，接口保持 `load / submit / rankOf / top / size`。
2. `lib/http.js` 的静态托管交给 Cloudflare Pages / R2，Worker 只处理 `/api/*`。

D1 建表：

```sql
CREATE TABLE best_runs (
  owner_id     TEXT PRIMARY KEY,     -- 每人一条，覆盖规则在应用层
  run_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  code         TEXT NOT NULL,
  score        INTEGER NOT NULL,
  best_speed   REAL NOT NULL,
  duration_sec INTEGER NOT NULL,
  ended_by     TEXT NOT NULL,
  ended_at     INTEGER NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  runs         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX best_runs_rank ON best_runs (score DESC, best_speed DESC, first_at ASC);

CREATE TABLE seen_runs (            -- 防重放：同一个 runId 只算一次
  run_id TEXT PRIMARY KEY,
  at     INTEGER NOT NULL
);
```

排名查询：`SELECT COUNT(*) + 1 FROM best_runs WHERE score > ?1 OR (score = ?1 AND best_speed > ?2)`。

> 这条路最省钱也最省运维，但它是唯一需要动代码的方案。如果只是想把游戏发出去，
> 别为了「无服务器」三个字多写一轮；A 或 C 更划算。

---

## 八、服务端是什么

`server/` 是零依赖 Node：没有 `npm install`，没有构建，`node app.js` 就起。

```text
server/
├── app.js                 # 路由 + 静态托管 + 限流 + 优雅退出
├── lib/
│   ├── engine.js          # 计分规则副本（必须和 index.html 的 ScoreEngine 一致）
│   ├── audit.js           # 成绩审计：事件重算 + 速率上界
│   ├── store.js           # 榜单存储：每人一条最佳，JSON 原子写
│   └── http.js            # JSON 收发、限流、静态文件、gzip
├── test/                  # node --test，不装依赖就能跑
├── tools/smoke.js         # 部署后自检
└── deploy/                # nginx.conf、Caddyfile、compose、systemd、fly.toml
```

它做四件事：托管首页（gzip + ETag）、收成绩（先审后入榜）、发榜单（前 20 + 你自己的名次）、
算名次（`/api/rank`）。

### 接口契约

```http
GET /api/health
→ 200 {"ok":true,"engine":3,"total":123,"updatedAt":1700000000000,"uptimeSec":86400}
```

```http
GET /api/leaderboard?limit=20&owner=rider:r_abc
→ 200 {
  "ok": true, "engine": 3, "total": 123, "updatedAt": 1700000000000,
  "you": { "rank": 87 },            // 前 20 里没有你时，也照样知道自己是第几
  "runs": [
    { "rank":1, "id":"run_...", "name":"ALPHA", "code":"#0001",
      "score":9120, "bestSpeed":168.2, "durationSec":240,
      "endedBy":"wipeout", "endedAt":1700000000000,
      "verified":true, "you":false }
  ]
}
```

```http
POST /api/runs
Content-Type: application/json

{ "id":"run_xxx", "ownerId":"rider:r_abc", "name":"ALPHA", "code":"#0001",
  "engine":3, "seed":123456789, "startedAt":42.5, "rated":166,
  "durationSec":240, "bestSpeed":168.2, "distanceKm":9.8, "streakBest":2.5,
  "endedBy":"wipeout", "endedAt":1700000000000,
  "score":9120, "breakdown":{...},
  "log":["V@44.0:96/3","S@45.1:4","W@282.5:wipeout"],
  "logHash":"1a2b3c4d",
  "trace":[[0.3,96.1],[0.5,96.4]],
  "traceHash":"9f8e7d6c" }

→ 200 {"ok":true,"accepted":true,"verified":true,"rank":7,"total":123,"replaced":true,"score":9120}
→ 422 {"ok":false,"accepted":false,"reason":"score_mismatch"}
```

拒绝原因：

| reason | 含义 |
| --- | --- |
| `engine_mismatch` | 计分规则版本对不上，旧成绩不参与新版榜单 |
| `hash_mismatch` | 日志被动过，指纹对不上 |
| `bucket_mismatch` | 某个分桶和公式重算的结果对不上 |
| `rate_implausible` | 骑行速率超出速度轨迹允许的上界 |
| `score_mismatch` | 总分和各桶之和对不上 |
| `speed_mismatch` | 自报峰速和轨迹里的最高速对不上 |
| `no_trace` / `trace_too_short` | 没有速度轨迹（严格模式），或轨迹覆盖不到行程 |
| `too_short` / `score_too_low` | 不足 8 秒或不足 60 分 |
| `rate_limited` | 同一个 IP 交得太勤 |

---

## 九、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| **`PORT`** | `8787` | 监听端口 |
| **`HOST`** | `0.0.0.0` | 有反代就设 `127.0.0.1` |
| `STATIC_DIR` | 仓库根目录 | `index.html` 所在目录 |
| `DATA_FILE` | `server/data/board.json` | 榜单文件，挂 volume 或备份这个 |
| **`ALLOW_ORIGIN`** | `*` | 跨域白名单；同域部署建议收紧 |
| `TRUST_PROXY` | `0` | 设 `1` 才信任 `X-Forwarded-For` |
| `AUDIT_STRICT` | `1` | `0` = 放行没有轨迹的成绩（降级为 `verified:false`） |
| `SUBMIT_PER_HOUR` | `30` | 每 IP 每小时可提交局数 |
| `BODY_LIMIT` | `1048576` | 请求体上限，一局约 40 KB |
| `CSP_CONNECT` | 自动 | 额外允许的 `connect-src`；meta 是绝对地址时会自动补 |
| `HSTS` | `0` | HTTPS 后面设 `1` |
| `QUIET` | `0` | 设 `1` 关访问日志 |

---

## 十、成绩审计：挡什么、不挡什么

客户端交上来的是「事件日志 + 速度轨迹 + 自称的结算」，服务端做三件事：

1. **指纹**：`logHash` 必须是这份日志的 FNV-1a；事件时间单调；最后一条必须是 `W`。
2. **离散分重算**：闪电、突破、超频档、冲刺、契约、脱困、校准七桶按 `lib/engine.js` 重算，
   多报一分就拒。契约分只认 150/300/500 三档，冲刺倍率只认那四个值。
3. **连续分上界**：骑行速率用速度轨迹围上界——每段取两端较大速度、最大雷链、全程无伤的乘区，
   再按段长给余量，`×1.05 + 30` 是容忍线。

> **边界**：这挡的是改包、改分、伪造结算这类粗糙作弊。它**挡不住**全程伪造一条自洽轨迹的专业作弊——
> 那需要服务端权威模拟（客户端只发输入、物理在服务端跑），成本高一个量级，这一版没做。
> 接口里的 `verified` 意思是「通过了审计」，不是「绝对真实」。

---

## 十一、数据与扩容

单进程 + JSON 文件足够撑到几千人：入库是内存操作，落盘是 400 ms 防抖的原子写（写 `.tmp` 再 rename）。

不适合的情况：多实例、需要历史流水、需要按时间段查询。换 Postgres 时只替掉 `lib/store.js`
的五个方法，其余代码不动：

```sql
CREATE TABLE best_runs (
  owner_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL,
  score INTEGER NOT NULL, best_speed REAL NOT NULL, duration_sec INTEGER NOT NULL,
  ended_by TEXT NOT NULL, ended_at TIMESTAMPTZ NOT NULL, verified BOOLEAN NOT NULL,
  first_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, runs INTEGER NOT NULL
);
CREATE INDEX best_runs_rank ON best_runs (score DESC, best_speed DESC, first_at ASC);

CREATE TABLE run_log (          -- 全量流水，只写不读，留着复议
  run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, payload JSONB NOT NULL, at TIMESTAMPTZ NOT NULL
);
```

---

## 十二、上线检查清单

```bash
# 1. 服务活着
curl -s https://你的域名/api/health

# 2. 首页是游戏，压缩和缓存头对
curl -sI https://你的域名/ | grep -i -E 'etag|cache-control|content-encoding'

# 3. 冒烟一把（顺便验一次「假成绩必须被拒」）
node server/tools/smoke.js https://你的域名
```

人工确认：

- 点底部的 `RANK`：面板能打开、能列出成绩、自己的那行有青色竖线，按钮小字是 `#名次`。
- 跑一局到摔车：结算面板的「排行榜」从 `…核对中` 变成 `#n / 全球 N 人 · 已校验`。
- 断开网络再跑一局：结算面板显示 `离线 · 待补交`，联网重开页面后成绩自动补交（`localStorage` 的
  `thunder-pelican.pending.v1`，最多 3 局）。
- 手机 4G 下首屏多久能玩（1.35 MB gzip，通常 2–4 秒）。
- `board.json` 有没有定时备份（cron + 保留 7 天就够）。

回滚：把 `index.html`、`assets/skins/` 和 `server/` 换回上一个 tag，重启进程；榜单文件向下兼容（多字段忽略、少字段走默认）。

---
