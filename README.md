# CCPC Neo VP

![原项目](https://github.com/pstron/ccpc-neo-vp)

**CCPC 新赛制「实时榜单」模拟器** —— 用 RankLand 的历史榜单数据，把一场已经结束的比赛按真实提交时间轴重新放一遍。

选一场比赛 → 定开赛时刻 → 倒计时 → 看榜单一秒一秒长出来。做题在别的平台（QOJ / 牛客 / PTA 等）进行，本工具只提供榜单。

```bash
npm install
npm run dev        # Wrangler 本地开发，打开 http://127.0.0.1:8787
```

---

## 特性

- **434 场比赛**可直接选，搜索名称或 `uk`。
- **逐提交回放**：AC 数、总罚时、每题提交次数都按真实时间轴推进，可暂停、倍速、拖时间轴。
- **新赛制题号揭示**：过题队数达到门限才显示题号，门限 `min(⌊队数 × 20%⌋, 50)`。
- **顶部题号栏**按实时过题数排序，显示 `过题数/提交数`；未揭示的题不着色。
- **封榜**（任意比赛可选）：切到 ICPC 经典封榜样式 —— 题号全部可见，未出结果的提交显示为蓝色 `?N`，且 pending 提交**继续实时出现**；比赛计时器与进度条照常走。
- **金银铜奖区**：名次格按奖项半径染色，只给正式队伍，名额按当前正式队伍数实时算。
- **可收藏的 URL**：一场 VP 的全部设置都在地址栏里。
- Cloudflare Workers 运行时零依赖；深色/浅色主题，`prefers-reduced-motion` 下关闭动效。

---

## 安装

需要 Node **≥ 22** 和 Wrangler 4。项目将 API 部署为 Cloudflare Worker，静态页面由 Worker Assets 提供。

```bash
npm install
npm run dev                    # 本地 Worker
npm run deploy:dry             # 上传前检查，不会发布
npm run deploy                 # 部署到当前 wrangler 登录的账户
```

本地替代方案仍可运行原 Node 服务：`npm start`，打开 `http://127.0.0.1:5173`。

### NixOS

```bash
nix run .                      # 启动服务
nix run . -- --port 8080       # 传参数
nix run .#test                 # 跑离线测试
nix run .#test-e2e             # 跑真实数据回归（需要网络）
nix develop                    # node + jq + curl
nix flake check                # 离线测试
```

> 如果 `~/.cache/nix` 不可写（例如只读挂载），先 `export XDG_CACHE_HOME=$(mktemp -d)`。

### 命令行

```
--port <n>        监听端口（默认 5173，被占用自动顺延）
--host <addr>     监听地址（默认 127.0.0.1）
--data-dir <dir>  缓存目录（默认 $XDG_CACHE_HOME/ccpc-neo-vp）
--base-url <url>  RankLand API 基地址
--verbose         打印每个上游请求的详情
--clear-cache     清空缓存后退出
--cache-info      打印缓存占用后退出
-h, --help        帮助
```

环境变量：`PORT`、`HOST`、`CCPC_NEO_VP_DATA_DIR`、`RL_BASE_URL`、`RL_CONNECT_TIMEOUT_MS`、`RL_STALL_TIMEOUT_MS`。

---

## 使用

**① 准备页**：搜索并选择比赛，设置开赛方式（倒计时 / 绝对时刻）、封榜开关与时长、题号门限的统计范围。

**② 倒计时页**：大号倒计时，可「立即开始」或取消。

**③ 榜单页**

- 顶部：比赛名、阶段徽标（等待开始 / 进行中 / 已封榜 / 已结束）、榜单文件来源。
- 播放条：比赛时间、总时长、墙上时钟、进度条（可拖动跳转）、暂停/继续、倍速 1/2/5/10/60/300x、回到实时、解封。
- 过滤条：队伍/学校筛选、是否仅官方队伍参与排名、当前显示队数。
- 快捷键：`空格` 暂停/继续，`←/→` 前后跳 60 秒。

**封榜**。勾选启用（任何比赛都可以封）。时长来源优先级：

| 榜单文件 | 时长 | 默认开关 |
| --- | --- | --- |
| `frozenDuration` > 0 | 该值 | 开 |
| 显式 `frozenDuration: 0` | 60 分钟 | 关（尊重「本场不封榜」，可手动勾选覆盖） |
| 没有该字段 | 60 分钟（CCPC 惯例） | 开 |

封榜后榜单内容停在该时刻，**题号全部可见**，未出结果的提交显示为蓝色 `?N`（`N` = 该队对该题的提交次数）。**pending 提交继续实时出现**，比赛计时器与进度条也继续走。到终点自动解封，也可手动点「解封」。

**倍速与拖动**用于预习/复盘：想在 30 秒内看完 5 小时的榜单变化，把倍速拉到 300x。

### URL 参数

一场 VP 的全部设置都会同步到地址栏，刷新或收藏后直接回到同一场：

```
http://127.0.0.1:5173/?uk=ccpc2026preliminary&start=1790785531000&freeze_minutes=60
```

| 参数 | 含义 |
| --- | --- |
| `uk` | 比赛唯一键 |
| `start` | 开赛时刻，Unix 毫秒或 ISO 字符串 |
| `delay` | 相对倒计时秒数（未给 `start` 时生效） |
| `speed` | 倍速：1 / 2 / 5 / 10 / 60 / 300 |
| `freeze` | `off` 关闭封榜 |
| `freeze_minutes` | 封榜时长（分钟） |
| `scope` | 门限统计范围：`all`（默认）或 `official` |
| `official` | `0` 表示非官方队伍也参与排名 |
| `start_now` | `1` 表示忽略倒计时直接进入榜单 |

---

## 数据来源

数据来自 RankLand（<https://rank.ac>，站点为 <https://rl.algoux.cn>）的公开只读接口，无需鉴权：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v2/public/contests` | 全部比赛的元信息 |
| `GET /api/v2/public/contests/:uk` | 比赛详情（题目 alias / 标题 / 颜色 / 链接） |
| `GET /api/v2/public/files/:id` | 榜单文件元信息（下载 URL、sha256） |
| `https://cdn.algoux.cn/rankland/file/...` | 榜单文件本体（Standard Ranklist JSON） |

榜单格式是 **Standard Ranklist (SRK) v0.3.13**，规范见 [algoux/standard-ranklist](https://github.com/algoux/standard-ranklist)。

Worker 抓取榜单后在 Worker 运行时构建紧凑「时间轴」，并通过 Cloudflare Cache API 缓存比赛列表和时间轴。原 Node 服务保留本地磁盘缓存，方便离线开发和旧版运行方式。

比赛列表和榜单文件默认从 RankLand 获取；榜单归一化、时间轴构建和回放计算都在本地完成。也可以把本地 SRK 文件直接交给导入接口：

```bash
curl -X POST "http://127.0.0.1:8787/api/import" \
  -H "Content-Type: application/json" \
  --data-binary @ranklist.json
```

`POST /api/import` 接受原始 Standard Ranklist JSON，也接受 `{ "ranklist": <榜单>, "name": "显示名称", "uk": "本地标识" }`。接口会在本地构建并返回 `data.timeline`，不请求 RankLand；请求体上限为 50 MiB。导入结果不写入磁盘缓存。

### 网络

榜单文件约 2.5 MB。本工具**不设总时长超时**（慢不等于坏），只检测两种故障：

- **连接超时**（默认 30 秒收不到响应头）
- **读取停滞**（默认 45 秒没有新数据）

Node 本地服务可设置环境变量后重启；Worker 部署可在 `wrangler.jsonc` 的 `vars` 中配置 `RL_CONNECT_TIMEOUT_MS`、`RL_STALL_TIMEOUT_MS` 或兼容的 `RL_BASE_URL`：

```bash
RL_CONNECT_TIMEOUT_MS=60000 RL_STALL_TIMEOUT_MS=120000 nix run . -- --verbose
```

自检接口逐步测试「比赛列表 → 文件元信息 → 榜单下载 → 时间线构建」并报告每步耗时：

```bash
curl "http://127.0.0.1:8787/api/diagnose?uk=ccpc2026preliminary"
```

### 两种榜单数据形态

RankLand 上的榜单文件分两类，都会被处理，精度不同且界面会提示：

| | **精确格式** | **旧格式（降级）** |
| --- | --- | --- |
| 特征 | `statuses[].solutions[]` 带每条提交的时间戳 | `solutions` 为空，只有该题汇总 |
| 例子 | `ccpc2026preliminary`、`icpc2024preliminary-*` | `ccpc2017qinhuangdao`、`icpc2018qingdao` |
| 回放粒度 | 逐条提交 | 按已公布解题时刻跳变 |
| AC 数与总罚时 | 与官方完全一致 | AC 数准；罚时由 `tries` 近似 |
| 题目排序依据的「最晚提交时刻」 | 精确 | 不可知，退化 |
| 界面提示 | 无 | 顶部显示「排序降级」徽标 |

降级不会伪造时间：无法得知的提交不会凭空生成时间戳。

---

## 规则实现

完整形式化说明与测试对照见 [`docs/rules.md`](docs/rules.md)。要点：

1. **题号揭示**：某题过题队数达到 `min(⌊N × 20%⌋, 50)` 时题号才出现，此前显示 `?`。50 队是**上界**，20% 是实际门限。`N` 默认取全部队伍，可切换为「仅官方队伍」。
2. **顶部题号栏**：永远按**实时过题数降序**（同数按题号），每题显示 `过题数/提交数`（如 `285/286`）；未揭示的题不着色。
3. **列顺序**：整个榜单**只有一套列顺序**，就是顶部题号栏的顺序 —— 所有行都对齐同一套列，**一列永远对应同一道题**。行与行之间只有单元格内容不同。
4. **AC 后忽略**：队伍 AC 某题后，对该题的再次提交被完全忽略，不增加提交次数、不影响罚时。
5. **罚时**：首次 AC 的（按 `timePrecision` 取整的）时刻 + 每次计入罚时的失败提交 × 20 分钟。免罚结果以榜单文件里 `sorter.config.noPenaltyResults` 为准。
6. **封榜与解封**：见上文「使用」。
7. **奖项区**：名次格按金/银/铜染色，只给正式队伍。名额按 **10% / 20% / 30%** 从当前正式队伍数实时算（榜单文件显式给出名额时以它为准）。并列名次共享同一奖区。

### 实现细节

**① 用实时统计，不用官方快照。** 榜单文件里的 `problems[].statistics.accepted` 是发布时的最终快照，可能与「截至当前时刻的过题队数」不一致（例如评测重跑导致官方统计与提交列表不同步）。题号揭示、顶部过题/提交数、金银铜名额**一律按回放实时值**。

**② 规则 3 的逐队顺序不用于列式榜单。** 规则原文描述「每队自己的题目展示顺序」，但列式榜单只能有一套顺序，否则同一列在不同行意味着不同题目。实际渲染用顶部题号栏的顺序；那套逐队顺序实现在 `columnOrder()` 中并有测试覆盖。

### 与官方榜单的已知差异

RankLand 官方榜单在「AC 数与总罚时都相同」的并列组内，顺序并不总是遵循最后一次 AC 时间。本工具在并列组内按最后一次 AC 排序，因此**并列组之间**的名次顺序可能与官方略有差异 —— 分数与名次结构完全一致，只是并列内部顺序不同。

---

## 测试

```bash
npm test                        # 130 个离线测试
VP_E2E=1 npm run test:e2e       # 真实数据回归（需要网络）
```

离线测试覆盖：SRK 解析与单位换算、规则各分支、封榜/解封完整生命周期、pending 实时推进、会话时钟（暂停/倍速/跳转/拖动）、奖项名额、缓存与静态服务路径安全、HTTP 响应框架。

真实数据回归对 **2026 CCPC 网络预选赛**（2170 队 / 30963 条提交）断言：

- 每队 AC 数与总罚时与官方榜单 **0 处不一致**；
- 每个名次上的 `(AC 数, 罚时)` 与官方逐个吻合；
- 快照加速回放在 7 个时间点上与从头回放完全一致；
- 旧格式场次（2017 CCPC 秦皇岛）降级后 AC 数仍与官方一致。

---

## 项目结构

```
worker.mjs           Cloudflare Worker API 入口
wrangler.jsonc       Worker 与静态资源配置
scripts/build.mjs    准备 Worker Assets 目录
server/
  index.mjs          HTTP 服务、路由、CLI、keep-alive 调优
  rankland.mjs       RankLand 只读客户端（连接/停滞看门狗、退避重试）
  build-timeline.mjs SRK → 紧凑「时间轴」、门限、奖项声明
  cache.mjs          原子写磁盘缓存
  assets.mjs         静态资源服务（含路径穿越防护）
shared/              同构模块：Node 与浏览器共用
  srk.mjs            单位换算、结果码、文本提取
  rules.mjs          计分、排名、题号揭示、列顺序、奖项（纯函数）
  replay.mjs         回放控制器、快照加速、封榜解析、pending 统计
  live.mjs           VP 会话时钟（锚点 + 倍速 + 分离/暂停）
web/                 无构建步骤的前端
  index.html  ui.css
  app.mjs            界面状态机与交互
  board.mjs          行虚拟化榜单渲染
dist/                构建时生成，作为 Cloudflare Worker Assets 上传
test/                node:test 测试 + fixtures
docs/rules.md        规则形式化说明与测试对照
```

前端是原生 ESM + CSS，没有框架；构建脚本只把 `/app/*` 与 `/shared/*` 整理到 Worker Assets 目录。榜单用行虚拟化渲染 2700 行。

---

## FAQ

**榜单不动 / 一直显示 0:00:00？** 倒计时结束前比赛时间是负数，停在倒计时页是正常的。

**为什么有的题号一直不显示？** 该题过题队数始终没到门限，属预期行为。

**封榜后为什么还能看到新的提交？** 封榜隐藏的是**结果**，不是提交。蓝色 `?N` 的数量会继续增长，解封后才会变成真实的绿/红。

**为什么每支队伍的题目顺序看起来不一样？** 不会 —— 所有行共用顶部题号栏的顺序，一列对应一题。列位置不代表题号本身（题号顺序是按过题数排的）。

**时间对不上真实比赛？** 时间轴按榜单文件里的比赛时长从头播放，与原始比赛的实际日期无关。

**旧场次的题目排序不对？** 该场榜单文件不含提交时间轴，排序退化，页面顶部有「排序降级」提示。

**能换数据源吗？** 可以，`--base-url` 或 `RL_BASE_URL` 指向兼容的 RankLand 部署。

**下载很慢？** 见上文「网络」，可放宽超时并打开 `/api/diagnose`。

---

## 合规与许可

- 本工具是**非官方**的个人学习工具，与 RankLand、CCPC、ICPC 均无关联。
- 仅调用 RankLand 的公开只读接口，请自行控制使用频率（默认只抓一次并落盘缓存）。
- 榜单数据版权归其各自作者所有，不在本仓库的 MIT 许可范围内（见 `LICENSE` 末尾）。
- 代码以 MIT 许可发布。

---

## 致谢

本仓库的代码、测试与文档由 **DeepSeek-V4.1-Flash** 通过 **DeepSeek Harness** 完成。

依赖的第三方格式与数据：

- [Standard Ranklist](https://github.com/algoux/standard-ranklist) —— 榜单 JSON 格式（v0.3.13）
- [RankLand](https://rl.algoux.cn) —— 数据来源
