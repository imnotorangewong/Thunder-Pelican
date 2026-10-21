# 传输与 GitHub Pages 部署

这个目录本身就是一个可直接推送的静态站点仓库。`index.html` 是游戏入口，`assets/skins/` 存放按需加载的骑手插画。

## 1. 解压并检查

拿到交付用的 `ThunderPelican.zip` 后解压，进入 `thunder-pelican/`：

```bash
cd thunder-pelican
ls -la
```

应当能看到 `index.html`、`README.md`、`.github/` 和 `assets/`。

> 不要把 zip 文件直接上传到 GitHub 当作网页；GitHub Pages 不能自动解压它。
> 先把文件解压，再上传/推送文件夹内容。

## 2. 推送到 GitHub

### 方式 A：Git 命令行

先在 GitHub 新建一个空仓库，例如 `thunder-pelican`，不要勾选自动生成 README。

```bash
cd thunder-pelican
git init
git add .
git commit -m "feat: thunder pelican single-file canvas"
git branch -M main
git remote add origin https://github.com/<your-username>/thunder-pelican.git
git push -u origin main
```

### 方式 B：GitHub CLI

```bash
cd thunder-pelican
git init
git add .
git commit -m "feat: thunder pelican single-file canvas"
git branch -M main

gh auth login
gh repo create thunder-pelican --public --source=. --remote=origin --push
```

### 方式 C：网页上传

1. 在 GitHub 新建仓库。
2. 点击 **Add file → Upload files**。
3. 把解压后文件夹里的内容拖入上传区域。
4. 注意 `assets/`、`.github/` 等目录也要上传；macOS Finder 中按
   `Cmd + Shift + .` 可以显示隐藏文件。
5. 如果网页上传没有保留 `.github/workflows/pages.yml`，可以在 GitHub 网页中
   新建同样的 workflow 文件，或直接使用 Pages 的分支部署方式。

## 3. 开启 GitHub Pages

### 推荐：GitHub Actions

1. 仓库 **Settings → Pages**。
2. **Build and deployment → Source** 选择 **GitHub Actions**。
3. 回到 **Actions**，运行或等待 `Deploy static site to GitHub Pages`。
4. 完成后访问：

```text
https://<your-username>.github.io/thunder-pelican/
```

### 备选：直接从分支部署

1. **Settings → Pages**。
2. Source 选择 **Deploy from a branch**。
3. Branch 选择 `main`，目录选择 `/ (root)`。
4. 保存并等待部署。

这个项目没有构建步骤，根目录的 `index.html` 和 `assets/skins/` 可直接部署为静态站点。

## 4. 更新

```bash
git add .
git commit -m "update: ..."
git push
```

如果使用 Actions，push 后会自动重新部署。

## 5. 常见问题

**Pages 显示 404**
- 确认仓库根目录有 `index.html`。
- 确认 Pages 的 Source 设置正确。
- Actions 部署需要等待工作流完成；第一次通常需要一两分钟。

**工作流没有出现**
- 检查 `.github/workflows/pages.yml` 是否上传成功。
- 也可以直接在 GitHub 网页的 Actions 页面手动创建并粘贴 workflow 内容。

**Space 没有打开皮肤库**
- 这是故意的。`SKIN` 用鼠标点或者按 Enter，Space 留给闪电和加速，
  不然会和二档连按打架。

**进度没有保留**
- 进度存在浏览器 `localStorage` 里。换域名、换端口、换打开方式，数据都不通。
- 清掉站点数据，皮肤和历史最高速度就归零了。

**没有声音**
- 浏览器要求先点一下页面才肯出声。点完音效按钮再试。

## 6. 自定义

- 想换仓库名：修改远程地址即可，页面本身不依赖仓库名。
- 想绑定自定义域名：在 Pages 设置中配置 Custom domain，并按 GitHub 提示添加 CNAME。
- 想改皮肤解锁条件：编辑 `index.html` 中 `SKINS` 每项的 `unlock`（`kind` + `value`），
  可选 `speed` / `score` / `km` / `runs` / `wrecks` / `hyper` / `perfect` / `clean` / `night`。
- 想改突破概率：编辑 `attemptLimitBreak()` 的概率曲线或 `SPEED_LIMIT_MAX`（额定速度表改 `SPEED_TIERS`）。
- 想改本机排名口径：编辑 `CREW_SORTS`，每个口径提供 `metric` / `value` / `meta` / `label`。
- 想改征程契约：`CONTRACT_BONUS` / `CONTRACT_XP` / `CONTRACT_COOLDOWN` 控制奖励和间隔，
  目标本身在 `contractPool()` 里，按档位返回一组 `{ key, target, label }`。
- 想改幽灵线：`GHOST_MAX_POINTS` 决定曲线最多留多少个点，采样间隔跟着 `SCORE_LOG_SAMPLE` 走。
- 想改鲸鱼彩蛋的节奏：`spawnSkyWhale()` 里的停留时长、`scheduleSkyWhale()` 里的出现间隔，
  以及 `drawSkyWhale()` 的透明度。
- 想改整点结算：`nextHourAt()` 决定结算节拍，`settleHour()` 里判定前三并解锁皮肤，
  下次结算时间存在 `localStorage` 的 `thunder-pelican.settle.v1`。
- 想改骑手称号/号牌配色/名字长度：编辑 `RIDER_TITLES`、`RIDER_ACCENTS`、
  `RIDER_NAME_MAX`。
- 想改成长曲线/冲刺：编辑 `SPEED_TIERS`、`RUN_DURATION`、`RUN_CHANCE`、
  `RUN_WARMUP`、`RUN_COOLDOWN`、`RUN_GRADES`。
- 想改压力彩蛋：编辑 `PRESSURE_CHANCE`、`PRESSURE_WARMUP`、`PRESSURE_COOLDOWN`、
  `PRESSURE_DURATION`、`PRESSURE_NEED`。
- 想改雷霆反噬概率：编辑 `ACCIDENT_CHANCE`、`ACCIDENT_COOLDOWN`、`ACCIDENT_WARMUP`。
