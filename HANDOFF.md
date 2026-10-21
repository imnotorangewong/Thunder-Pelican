# 交接说明

给接手的人。功能细节看 `README.md`，部署看 `DEPLOY.md`（静态）/ `DEPLOY-SERVER.md`（带排行榜服务）。
这一页只讲三件事：**这版相对原压缩包改了什么**、**现在是什么状态**、**别踩哪里**。

## 最新交接（2026-10-21）

- 角色皮肤复审与修正已经做完：保留每个角色自己的主题徽记，尺寸适中且不变形；骑行形态检查两腿分居车架两侧；昼夜双龙保留双形态切换。
- 新增/调整速度玩法：雷霆二档持续 5 秒、冷却 8 秒，前三秒按滚动一秒峰值 CPS 结算，3 CPS 起增幅；每次开启有 5% 幸运判定；完美轮盘次数提升后续二档可用上限，全局限速 340 KM/H。
- 轮盘开始前三秒出现左侧氮气倒计时。倒计时使用游戏时钟，暂停冻结；冲刺、巨石和资料/奖励面板等阻塞状态会取消并顺延。
- 性能改动：城市天际线离屏缓存；非鹈鹕插画皮肤跳过雷电粒子/轮胎电弧的生成和更新；性能模式粒子上限降至 160，并减弱粒子模糊；页面隐藏或暂停时跳过 Canvas 重绘。
- 服务端审计速率上界以最低额定速度 166 计算。原因是氮气 cap 不再代表骑手等级；评分引擎 v3 与各桶得分公式保持不变。
- 尚未将这轮改动部署到服务器：之前的 SSH 登录被服务器以 `publickey` 拒绝，本机没有可用私钥。不要把 `https://182.92.206.75/` 当前页面当成已更新版本；需先在云端配置 SSH 凭据，再按 `DEPLOY-SERVER.md` 发布。
- 本交接包是工作目录快照，没有 `.git` 元数据；云端继续前应把快照导入项目仓库/分支。此轮没有运行测试。

详见 `CLOUD-HANDOFF-2026-10-21.md`，其中包含改动文件和下一步接手建议。

---

## 零、第二轮改动：排行榜只留一份（在服务器上）

这一轮只碰三块：**计分之外的榜单**、**结算面板的名次**、**新增的 `server/`**。
渲染层、皮肤、音频、物理一行没动。

### 0.1 没有本机榜了

原版把「本机最佳十局」存在 `localStorage`。这一轮把它整个删掉：

| | 之前 | 现在 |
| --- | --- | --- |
| 榜在哪 | `localStorage` 的 `board.v1` / `board.v2` | 只在服务端（`server/lib/store.js`） |
| 怎么进榜 | 本地排序，前十 | 上传 → 服务端审计 → 入榜 |
| 名次 | 本机第几 | 全球第几（前二十 + 你的名次） |
| 没服务器 | 还能看本机榜 | 没有榜，`RANK` 面板写明「没有接入排行榜」 |

删掉的代码：`loadBoard` `saveBoard` `boardRows` `boardPlace` `bankOnBoard` `normalizeEntry`
`beatsEntry` `migrateBoard` `pruneBoard` `adoptLegacyRecords` `renderBoard` `renderGlobalBoard`
`settleStanding` `settleRank`，以及 `BOARD_*` 常量。
保留的：`ownerKey()`（上传时的身份）、`sanitizeRun()`（上传前的数值夹取）、个人最佳幽灵线（本机的训练辅助，不是榜）。

> 旧的 `thunder-pelican.board.v1` / `.v2` 还躺在老用户的 `localStorage` 里，代码不再读它，
> 也不主动删——那是用户数据，留着不碍事。

### 0.2 排行榜改成独立按钮 + 独立面板

之前榜塞在骑手档案底部，档案越拉越长。现在控制条上 `SKIN` 右边有 **`RANK`**，
点开是 `#rank-modal`（复用 `.skin-modal` / `.skin-panel` 的骨架，换成青色主题）：

- 前 20 名，一行一个人：名次、名字、`号牌 · 峰速 · 时长`、分数。
- 自己那行青色高亮，前三的序号是酸绿色。
- 底部固定一行 `你 / YOU #87 / 1284`：掉出前 20 也知道自己第几。
- 按钮小字跟随状态：`#87` / `TOP` / `…` / `×` / `OFF`。
- Esc、点背景、`关闭` 都能收；打开时 `world.inert = true`，和其它面板一样互斥。

排行面板的开关是 `rankPanelOpen`，**必须**加进那几处互斥判断（成就队列、皮肤库、骑手档案、校准触发、
压力/冲刺触发、刷车判定），漏一处就会出现「面板开着还在刷车」。

### 0.3 名次只认服务器

结算面板的「排行榜」格：开面板时先显示 `…核对中`，`Leaderboard.whenSubmit(runId, cb)` 等回执，
到了才填 `#n / 全球 N 人 · 已校验`；网络失败显示 `离线 · 待补交`，被拒显示 `未收录`。
「新纪录」那条也一样：服务端 `replaced === true` 才点亮，第一名写 `NEW GLOBAL RECORD`，否则 `PERSONAL BEST`。

整点结算（黄金时刻）同理：`settleHour()` 现在调 `Leaderboard.refresh()`，读 `data.you.rank`，
前三才解锁。没接服务器 → 提示「排行榜在服务器上」，不解锁。

**决策记录**：预期玩家规模不大，黄金时刻保持「全球前三」，不要改成前 10 或百分比。
规则写在排行榜面板底部（`#rank-hint`），会显示「你现在第 n 名，整点一到就解锁」或「还差 n 名」，
玩家不用去翻文档。另外整点每小时都会过一次，已经拥有的皮肤不再重复弹成就卡——改 `settleHour()`
时别把 `if (!skinUnlocked.has("golden"))` 里的 `queueAchievement` 挪到外面。

### 0.4 上传失败会排队

`thunder-pelican.pending.v1` 最多存 3 局没送出去的成绩，下次打开页面 `flushPending()` 补交。
服务端的 `runId` 去重保证补交不会重复计次。这条是删掉本机榜之后的补偿：以前成绩至少还在本机，
现在必须有地方兜住「关页面时网络抖了一下」。

### 0.5 这轮改动的文件

| 文件 | 变化 |
| --- | --- |
| `index.html` | 删本机榜；加 `RANK` 按钮 + 排行榜面板；上传队列；结算/整点名次改读服务器 |
| `server/app.js` | `/api/leaderboard` 多返回顶层 `you: {rank}` |
| `server/deploy/` | 新增 `docker-compose.yml`、`Caddyfile`、`fly.toml` |
| `DEPLOY-SERVER.md` | 重写：五套部署方案对比 + 命令 |
| `README.md` | 「本机排行榜」「服务器榜」合并成「排行榜」；存储清单、皮肤条件同步 |
| `assets/` · `LICENSE` · `.github/` | 未动 |

---
## 一、相对原压缩包（`ThunderPelican-20261020.zip`）的改动

### 1. 文件层面

| 文件 | 原包 | 现在 | 变化 |
| --- | --- | --- | --- |
| `index.html` | 648,385 B | 2,184,709 B | **+1.53 MB**，其中 1.40 MB 是背景音乐，38.7 KB 是排行榜面板与服务器适配 |
| `README.md` | 27,055 B | 37,200 B | 补了音乐、设置、30 秒挑战、结算面板、榜单覆盖规则、服务器榜 |
| `HANDOFF.md` | 3,117 B | 本文件 | 重写，加了改动清单 |
| `DEPLOY.md` · `LICENSE` · `assets/` | — | — | **未动** |

第二轮新增了一个 `server/` 目录（零依赖 Node，可选）和 `DEPLOY-SERVER.md`、`Dockerfile`、`.dockerignore`；
其余文件没动，11 张截图逐字节未变。原来的 `.github/workflows/pages.yml`
只拷贝 `index.html` 到 `_site`，所以所有素材（含音乐）都必须内嵌 base64，别改成外链。

### 2. 代码层面

| 项目 | 原包 | 现在 |
| --- | --- | --- |
| 函数 | 219 | 237（+19 / −1） |
| 顶层常量 | — | +7 / −1 |

新增函数：
`startTrial` `trialTick` `trialIdleText` `endTrial`（30 秒挑战）·
`loadAudioMix` `saveAudioMix` `applyAudioMix` `armAutoplay` `syncSettingsUI` `setSettingsOpen`（声音设置）·
`buildGoldenBodyCanvas` `goldenPose` `goldenLocal` `goldenLegSamples` `goldenLegPath`
`drawGoldenLeg` `drawGoldenFoot` `drawGoldenFace`（黄金时刻）· `settleGrade`（结算评级）

删除：`setSound`（被设置面板取代）、`GOLDEN_EYES`（眼位改由 `GOLDEN_ART.eyeNear/eyeFar` 提供）

新增常量：`GOLDEN_ART` `TRIAL_SECONDS` `TRIAL_HOLD` `AUDIO_KEY` `MUSIC_HEADROOM`
`MUSIC_STORM_SRC` `SETTLE_GRADES`

### 3. 功能新增（5 项）

| # | 内容 | 要点 |
| --- | --- | --- |
| 1 | **`GOLDEN HOUR` 骑行动作重做** | 参考图里那两条站着的腿在胯线裁掉，腹底补圆后淡入，接上一对按踏频驱动的短腿；龙抬头时张嘴大笑 + 眯眼。腿是"沿中心线铺圆"的联集体，不是偏移多边形 |
| 2 | **`LIANG WENBEE` 换头** | 参考照片做成 JOJO 风漫画头：四阶赛璐璐分色 + Sobel 墨线 + 冷紫阴影；脖子竖直拉伸加长后**插进胸腔**（`drawThorax()` 画两遍），胸口接触阴影盖住接缝；眼弧闪电改红色 |
| 3 | **30 秒挑战** | 控制条加 `开始游戏` 按钮。每局 `startTrial()` 申请一个临时数组，逐帧 push 速度，到点 `reduce` 取最大值为本局结果，数组置 `null` |
| 4 | **背景音乐 + 声音设置** | 135 秒 AAC 64k 内嵌循环；设置面板替换原 `SOUND ON/OFF`，音乐 / 闪电音效 / 皮肤语音三条独立通道，各有开关 + 音量条，默认全开全满，存 `thunder-pelican.audio.v1` |
| 5 | **结算面板** | 原超频翻车结算卡扩展：本局最快 / 历史最快（破纪录变绿）/ 排行榜位次（占位）/ A–E 综合评级；底部按钮改为 `确认 / CONFIRM` |

### 4. 行为改动（3 项）

- **每次进页面强制穿 `ORIGINAL`**：`loadSkinProgress()` 之后一行 `applySkin("original", {persist:false})`。
  只影响这一屏的形象，不动存档；换骑手仍按骑手记录换皮。
- **`SOUND ON/OFF` 按钮 → `设置` 面板**（功能被吸收，原按钮删除）。
- **`召唤闪电` 按钮收窄**：`min-width` 218 → 168、内边距 18 → 13、副标题 `Summon the storm` → `Summon`，
  避免窗口偏窄时控制条压到左侧速度表。

### 5. 没动的地方

计分引擎（`SCORE_ENGINE_VERSION = 3`）、本机排行榜四种口径、征程契约、个人最佳幽灵线、
皮肤解锁条件与判定、雷霆二档物理与翻车概率、压力巨石 / 鲸鱼 / 整点结算三个彩蛋的触发逻辑。
改动全部集中在**渲染层**（两套皮肤的画法）、**音频层**（新增）和**两个新 UI**（设置、结算）。

---

## 二、现状

- 单文件 `index.html`，**2.1 MB**，没有构建步骤，没有依赖，双击就能跑
- 素材全部内嵌 base64：四条语音、鲸鱼剪影、蜂头、奶蛙贴图、召唤音效、**背景音乐**
- 十七套皮肤：七套常规 + 十套彩蛋
- 计分引擎纯函数，服务端有同一套公式的副本（`server/lib/engine.js`）
- 排行榜只有一份，在服务端；本机不留榜，底部 `RANK` 按钮打开面板
- `server/` 可跑：`node app.js` 起服务，`node --test` 跑 15 个用例，`node tools/smoke.js <url>` 做部署自检

> `preview/` 是开发期的离屏预览与测试工具（`record.js` / `render.py` / `test-trial.js` /
> `test-audio.js` / `test-grade.js` / `build-bee-head.py`），需要 Node 与 Python，**不进包**。
> 要复现皮肤画法或改评级阈值时再拿回来。

---

## 三、发布前必看：全解锁预览代码

`index.html` 启动段里有一段无条件解锁，是给作者预览皮肤用的：

```js
/* every skin is handed out at boot — delete this block to restore the
   normal unlock flow (the conditions and progress bars are all still there) */
for (const skin of SKINS) skinUnlocked.add(skin.id);
```

**打包版里这一行已经删掉**（保留 `updateSkinButton()` 等启动调用），发布出去是正常的解锁流程。
如果你的**工作副本**还留着它，本地会一开局满皮肤——想恢复发布形态，删掉 `for (...)` 那一行即可，
不要连下面的 `updateSkinButton()` / `updateRiderPreview()` 一起删。

---

## 四、容易踩的地方

- **改计分常数要改两处**：`index.html` 的 `ScoreEngine` 和 `server/lib/engine.js` 是同一套公式的两份副本，
  改完把 `SCORE_ENGINE_VERSION` 加一。版本号不动，旧规则的成绩会混进新规则的榜单，审计还会开始误杀。
- **别删 `ride.trace`**。服务端拿它给「骑行速率」这一桶围上界；没有轨迹，严格模式（默认）全部拒收 `no_trace`。
- **上传体积卡在 64 KB**：`log` 最多 720 条、`trace` 最多 2000 点，加起来约 40 KB，
  正好塞进 `fetch(keepalive)` 的上限。往 payload 里加东西之前先算这个数，超了 `pagehide` 那次提交会静默失败。
- **别把名次算在本地**。这一版没有本机榜：`settleRank` 之类的东西全删了，面板名次只来自
  `Leaderboard.whenSubmit()` 的回执。想加「本地估算」请先想清楚——那会立刻变成两套名次打架。
- **`rankPanelOpen` 要加进所有互斥判断**（成就队列、皮肤库、骑手档案、校准、压力/冲刺、刷车）。
  漏一处就是「面板开着还在刷车」。
- **上传失败要进 `pending.v1`**：删本机榜之后，这是成绩唯一的兜底。改 `submit()` 时别把
  `enqueue` 的分支删掉，尤其是 `catch` 里那次。
- **`?debug=1` 的钩子**：`window.__thunderPelican`（`ride` / `finishRun` / `previewSettle` / `openRank`）
  只在 URL 带参数时存在，正常访问时 `window` 是干净的。别在正常代码路径里引用它。
- **`you` 标记是服务端算的**：客户端把 `owner=<key>` 放进查询串，服务端比对后返回 `you:true` 和顶层的
  `you.rank`，不会把别人的 ownerId 发出来。

- **骑手模型是分皮肤分支的**。`drawBikeAndPelican` 里按 `activeSkin` 分派，
  腿在三个地方画（远端、冲刺残影、近端）。奶蛙皮肤三处都加了 `!activeSkin.golden`，
  只加一处的话，高速冲刺时会冒出淡色残影腿。
- **别给贴图骑手加游戏腿**。奶蛙自带腿，叠上去就是四条。
- **`GOLDEN HOUR` 的腿画在身体之前**，胯部由上腹盖住；改到身体之后画，接缝会露在肚皮上。
  腹底那块是单独一张 canvas 画完再淡入的，`destination-out` 的淡出必须收在 `clearRect` 那一行之上，
  否则半透明区会透出背景，看着像肚皮上一条黑线。
- **`GOLDEN HOUR` 的腿是"沿中心线铺圆、一次性 nonzero 填充"的联集体**（`goldenLegSamples` +
  `goldenLegPath`）。别改回偏移多边形：腿根半径（32）比膝盖的弯折半径大，内侧会裂出一个缺口，
  描边还会画出内部的自交线。圆的并集天然没有角。
- **`GOLDEN HOUR` 的脸画在精灵自己的像素坐标里**（`drawGoldenFace`），不是车身坐标。
  换 `scale`/`cx`/`crotch` 不用动嘴的位置；换精灵图才要。
- **`LIANG WENBEE` 的头像是脚本生成的**（`preview/build-bee-head.py` → 300×437 WebP → `BEE_FACE_SRC`）。
  流程：四阶赛璐璐分色 + Sobel 墨线 → 下巴下方整段竖直拉伸做出脖子（上边界与原始像素重合，所以无缝）
  → 按亮度自适应把背光的脖子提到下颌的亮度 → 白色热核 + 红色辉光贴回激光眼 → 按描好的轮廓抠图。
  改参数重跑脚本就行，别手改 base64。
- **头按 `naturalHeight/naturalWidth` 缩放**，塞进正方形会把脸压扁。眼位 `BEE_EYES` 是按这张图量的
  （33.5% / 67.5% 横向，约 53% 纵向），换图必须重量，否则眼神光和闪电会飘到眉毛上。
- **脖子是"插进"胸腔的，不是贴在胸上**：`drawThorax()` 会画两遍，第二遍在头之后，把颈部根部盖住；
  胸口的接触阴影也在 `drawThorax` 里。把第二遍调用删掉，脖子会重新浮在胸口前面。
- **结算面板的评级在 `SETTLE_GRADES`**（分数 / 峰值双阈值，任一达标）。排行榜那一格是异步的：
  先 `…核对中`，`Leaderboard.whenSubmit(runId)` 回执到了才填 `#n`；面板关掉了就不再写 DOM
  （回调里第一行就是 `if (!wipeResultOpen) return`）。
- **进页面强制穿 `ORIGINAL`**：`loadSkinProgress()` 之后有 `applySkin("original", {persist:false})`。
  想恢复"刷新保留上次皮肤"，删掉那一行。
- **30 秒挑战的数组是每局新建的**：别挪到外面复用，结算后必须置 `null`，
  否则上一局的峰值会带进下一局。按钮的 `done` 状态只挂 6 秒，靠 `state.time` 判。
- **背景音乐是 `<audio>` + `loop`，闪电音效是 WebAudio**，两条路互不相干：音乐调 `musicEl.volume`
  （乘 0.72 的余量），音效调 `audio.setVolume()`（改主增益，不动 `AudioContext` 本身）。
  皮肤语音是独立 `Audio` 实例，`player.volume` 单独设。别把它们合并成一个主音量。
- **自动播放会被浏览器拦**。`applyAudioMix()` 先试 `play()`，被拒就 `armAutoplay()` 挂一次
  `pointerdown/keydown` 补播。删掉这段，用户第一次进来会没有音乐且没有任何提示。
- **`localStorage` 有六个 key**：`riders.v1`、`skins.v1`、`board.v1`、`crew.v1`、`ghost.v1`、
  `settle.v1`；这一版新增 **`audio.v1`**（声音设置）。改数据结构记得升版本号。
- **无头截图有坑**：`--disable-gpu` 会丢 `backdrop-filter`；截图发生在第一帧 rAF 之前，
  HUD 显示的是静态初值。要拍运动中画面，得在注入脚本里手动 `update(1/60)` 若干次。
- **本地起服务测试要加 `?v=N`**，否则 Chrome 会用缓存里的旧 HTML。

---

## 五、重新出截图

截图在 `assets/screenshots/`，1440×900。做法是在 HTML 副本里注入一段脚本：
解锁皮肤、切到目标状态、跑若干帧 `update()`，然后 `--screenshot`。没有留脚本，
因为每张图的前置条件不同，硬写一个通用脚本反而更难维护。

> **已知过时**：`10-bee.png`（梁文蜂还是旧照片头）和 `11-golden.png`（黄金时刻还是贴纸腿）
> 拍的是上一版形象，这一版没有重拍。`09-new-skins.png` 没有被任何文档引用。

## 六、文件大小

| 阶段 | 体积 | 增量来源 |
| --- | --- | --- |
| 最初 | 590 KB | — |
| 加奶蛙 + 音效 | 641 KB | 奶蛙贴图 WebP 23 KB（base64 30 KB）、召唤音效 AAC 9 KB（12 KB） |
| 加音乐 + 新形象 | 2.1 MB | 背景音乐 AAC 1.0 MB（base64 1.4 MB）+ 黄金时刻的腿/表情、梁文蜂头像、两个新 UI 约 30 KB |
| **本版** | **2.08 MiB**（2,184,709 B） | 排行榜面板、上传/补交队列、速度轨迹、debug 钩子合计 +39 KB，全是代码（本机榜是删掉的，净增没那么多） |

背景音乐是体积的唯一大头。压到 1.7 MB 可以把音乐降到 48 kbps；升到 96 kbps 大约 +0.6 MB。
再往单文件里塞图之前，先想一下这个数字。
