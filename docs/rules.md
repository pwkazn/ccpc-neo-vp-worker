# CCPC 新榜单模式 —— 规则形式化与实现对照

本文把 CCPC 新榜单模式的规则说明翻译成可执行的形式化描述，并逐条对应到代码位置与测试用例，便于规则微调时定位修改点。

**唯一权威实现**：[`shared/rules.mjs`](../shared/rules.mjs)。该模块不依赖 DOM 与网络，Node 与浏览器共用。

---

## 0. 术语与数据模型

数据来自 [Standard Ranklist](https://github.com/algoux/standard-ranklist)（v0.3.13）榜单文件：

| 概念 | 数据来源 |
| --- | --- |
| 队伍数 `N` | `ranklist.rows.length`（或其中 `user.official !== false` 的数量） |
| 题目下标 `p` | `problems[p]` 的数组下标。**这是题号的唯一身份**：`statuses[p]` 严格对应 `problems[p]` |
| 题目别名 | `problems[p].alias`（如 `A`、`B`） |
| 提交事件 | `rows[team].statuses[p].solutions[]`，每条含 `result` 与 `time`，按时间升序 |
| 结果聚合 | `rows[team].statuses[p].result` ∈ `AC \| FB \| RJ \| null`；`tries` 为有效提交次数 |
| 时长单位 | `[值, 'min' \| 's' \| 'h' \| 'ms' \| 'd']` |
| 时间精度 | `sorter.config.timePrecision`（2026 年场次为 `"min"`） |
| 免罚结果 | `sorter.config.noPenaltyResults` |
| 封榜时长 | `contest.frozenDuration`（可选字段） |
| 奖项声明 | `series` 中 `rule.preset === 'ICPC'` 的 `segments` |

**回放状态**（每队、每题各一份）：

- `acAt[team][p]` —— 首次 AC 的比赛秒数，未 AC 为 `-1`
- `subs[team][p]` —— 有效提交次数（**AC 之后的不计**）
- `lastSub[team][p]` —— 最晚一次有效提交的比赛秒数
- `fails[team][p]` —— 其中计入罚时的失败次数
- `solved[team]` / `penalty[team]` / `lastAc[team]`
- `CountedSolves` —— 每题的**去重过题队数**与**去重提交队数**，用于揭示判定与顶部计数

事件按比赛秒升序逐条应用。因此对任意目标时刻 `T`，状态 = 所有 `time ≤ T` 的事件依次应用的结果，精确且可任意 `seek`，与「从头重放」在位点上完全一致。

**实现**：`createState`、`applyEvent`、`replayTo`、`createEpochReplay`。

---

## 1. 题号显示

> 比赛初始时，榜单不显示各题题号；当某个题的 AC 队伍数达到 50（或者【队数的 20%】下取整），该题的题号将显示在榜单中。

**形式化**

```
R = max(1, min( ⌊N × ratio⌋ , min ))        ratio 默认 0.2，min 默认 50
revealed(p, T) ⇔ |{ 已在 T 前 AC 题 p 的计数队伍 }| ≥ R
```

- `R` 在比赛开始时确定，`N` 不随比赛进行变化。
- 50 队是**上界**，`⌊N×20%⌋` 是实际门限：小比赛按 20%，大比赛封顶 50。
- 计数单位是**去重队伍数**，不是 AC 次数；**只统计 AC**，仅提交未过的不计入。
- 外层 `max(1, …)` 是实用下限：队伍数不足 10 时 `⌊N×20%⌋` 为 0，门限 0 意味着「无人过题就显示」。
- 计数范围可选「全部队伍」或「仅官方队伍」（`revealScope`），界面可切换。
- 全场无人达到 `R` 的题**始终不显示题号**，属预期行为。

**关键点：揭示用的是「截至当前显示时刻的实时过题队数」。**
`problems[p].statistics.accepted` 是发布时的快照，可能与回放统计不同。因此运行时由 `CountedSolves` 逐秒求值；服务器预计算的 `reveal.*.revealSec` 只用于自描述、`/api/diagnose` 展示与回归测试断言。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 门限公式 | `shared/rules.mjs` → `revealThreshold()` |
| 实时去重计数 | `shared/rules.mjs` → `CountedSolves`、`applyEvent()` |
| 每帧实时状态 | `shared/rules.mjs` → `problemStatus()` |
| 预计算（自描述 + 测试） | `server/build-timeline.mjs` → `computeReveal()` |
| 单元格是否暴露别名 | `shared/rules.mjs` → `cellInfo().alias` |
| 界面呈现 | `web/board.mjs` → 列头未揭示显示 `?` 且不着色 |

---

## 2. 榜单不按统一题目顺序展示

榜单**不按题号顺序**展示题目 —— 顺序由规则 5 决定（按实时过题数降序），所以列位置不能用来推断题号。

榜单是**列式**的，而列式榜单只能有**一套**顺序：否则同一列在不同行意味着不同题目。因此：

- 顶部题号栏定义顺序，**所有队伍的行都使用同一顺序**；
- 行与行之间只有**单元格内容**不同（绿/红/蓝、用时、次数）；
- 每个单元格同时带 `data-prob`（真实题目下标）与 `data-column`（列位置），表头亦然，二者必须一致。

规则 3 描述的那套**逐队顺序**实现在 `columnOrder()` 中并有完整测试，但**交互榜单不使用它** —— 它无法与列式布局共存。若将来要做「每队一段自定义顺序」的非列式视图，可直接复用。

**实现**：`shared/rules.mjs` → `problemStatus().order`（唯一来源）、`sharedColumnOrder()`（下发副本）。

---

## 3. 每队解题情况的题目顺序

> ⚫ 先展示显示题号的题目，顺序为题号由小到大；
> ⚫ 再展示剩余题目中队伍已 AC 的，顺序为 AC 时刻由早到晚；
> ⚫ 再展示剩余题目，顺序为最晚一次提交时刻由早到晚，未提交过的题按题号（但不会显示）由小到大排在最后。

> 如第 2 节所述，这套顺序**不用于列式榜单的渲染**，仅作为 `columnOrder()` 的实现与测试保留。

**形式化**：对队伍 `g`、时刻 `T`，把每题分到四个桶，按「桶优先级 → 桶内 key1 → key2」排序。

| 桶 | 条件 | key1 | key2 | 别名 |
| --- | --- | --- | --- | --- |
| `REVEALED` | `revealed(p,T)` | 题目下标 | — | **显示** |
| `SOLVED_HIDDEN` | 未揭示 ∧ `acAt[g][p] ≠ -1` | `acAt[g][p]` | 题目下标 | 隐藏 |
| `ATTEMPTED_HIDDEN` | 未揭示 ∧ 未 AC ∧ `subs > 0` | `lastSub[g][p]` | 题目下标 | 隐藏 |
| `UNTOUCHED` | 其余 | 题目下标 | — | 隐藏 |

要点：

- 桶 1 是**所有已揭示的题**，含未 AC 的题。
- 「剩余题目」= 未被桶 1 取走的题，所以桶 2/3 的题必然未揭示。
- 桶 3 的「最晚一次提交」不含 AC 之后的提交（见第 4 条）。
- 封榜时这套顺序也不变：封榜只改「哪些题号可见」与「单元格怎么画」，`columnOrder()` 仍按封榜时刻的 `acAt` / `lastSub` 计算。

**降级**：旧格式榜单没有逐条提交时间，桶 3 的 `lastSub` 不可知 → 退化为按题目下标排序。状态由 `timeline.coverage.exact` 标记，界面显示「排序降级」徽标。

**实现**：`columnOrder()`；桶常量 `BUCKET`；旧格式计数回退 `triesFallback`。

---

## 4. AC 后忽略该题的再次提交

> 不管是否封榜，队伍 AC 某道题后，对该题的再次提交将被忽略，不会增加对该题的提交计数。

**形式化**：`applyEvent()` 中若 `acAt[g][p] ≠ -1`，该事件被**完全丢弃**：

- 不增加 `subs[g][p]`（界面显示的次数不变）
- 不更新 `lastSub[g][p]`（不影响第 3 条桶 3 的顺序）
- 不增加 `fails[g][p]`（不影响罚时）
- 不影响 `solved` / `penalty` / `lastAc` / 提交队数计数

该规则在**封榜前后都成立** —— 它是回放语义，与封榜是两个独立机制。

**实现**：`applyEvent()` 开头的提前返回。

---

## 5. 顶部题号栏

顶部每个**题目列**同时表达三件事：

1. **题号**：已揭示（或封榜中）显示别名，未揭示显示 `?`；
2. **过题数 / 提交数**：截至**当前显示时刻**的去重统计，显示为 `AC/总提交`（如 `285/286`），两者都从回放事件流统计，**不用** `statistics.accepted` 快照；
3. **底色**：仅题号可见时着色（用 `problems[].style.backgroundColor`）；未揭示一律不着色，避免从颜色推断题号。

**排序**：永远按**实时过题数降序**，同数按题目下标升序。因此：

- 顺序**不固定**，每有队伍过题就可能改变；
- 封榜期间顺序**冻结**（因为统计被钉在封榜时刻）；
- 顶部列位置同样**不能**用来推断题号。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 实时计数 / 揭示集合 / 顺序 | `shared/rules.mjs` → `problemStatus()` |
| 每帧传入界面 | `shared/live.mjs` → `frame.stats` |
| 排序与着色渲染 | `web/board.mjs` → `renderHeader()`、`headerTitle()` |

---

## 6. 计分

> 榜单仍会显示每支队伍的 AC 题数、总罚时。

**形式化**

```
若队伍 g 首次 AC 题 p 的时刻为 a：
    penalty[g] += floor_to_precision(a) + fails[g][p] × penaltySec
    penaltySec 默认 1200 秒（20 分钟）
solved[g] = |{ p : acAt[g][p] ≠ -1 }|
totalPenalty[g] = floor_to_precision(penalty[g])
```

- `fails` 只累计**首次 AC 之前**、且结果 ∉ `noPenaltyResults` 的提交。
- `floor_to_precision` 按 `timePrecision` 下取整：`min` → `⌊秒/60⌋×60`，`h`/`d` 同理，`s`/缺省 → `⌊秒⌋`。
- **两级取整都要做**：逐题用时先取整，累加后的总罚时再取整。
- `RJ`（被拒）结果没有 `time` 字段，因此天然不产生罚时；`CE`/`NOUT`/`UKE` 等在 `noPenaltyResults` 内。

**实现**：`applyEvent()` 的 AC 分支；`floorToPrecision()`；免罚码集合来自榜单文件的 `noPenaltyResults`。

---

## 7. 排名

**形式化**

```
排序 key：( -solved , totalPenalty , lastAc )
并列定义：solved 与 totalPenalty 都相同（lastAc 只用于决定先后，不拆开并列）
名次：竞赛排名 1, 1, 3, …（并列组共享其首行的名次，下一名次按位置跳过）
官方队：user.official === false 的队伍列出但不参与排名（名次显示 —）
```

**实现**：`compareRows()`（排序）、`computeBoard()`（名次分配）。

**与官方榜单的已知差异**：RankLand 官方榜单在并列组内并不总按 `lastAc` 排序。本工具按 `lastAc` 排序，故**并列组之间**顺序可能略有差异，但分数与名次结构完全一致；e2e 回归断言到「每个名次上的 `(solved, penalty)` 与官方逐个吻合」。

---

## 8. 封榜与解封

> 比赛最后 1 小时封榜，封榜后榜单显示与原 XCPC 模式相同。

**形式化**

```
usesFreeze = freezeEnabled ∧ window > 0
frozenAt   = duration − window

!usesFreeze           → visibleSec = clamp(T)
T ≤ frozenAt          → visibleSec = clamp(T)        frozen = false
T > frozenAt ∧ 未解封  → visibleSec = frozenAt        frozen = true, revealPending = true
T > frozenAt ∧ 已解封  → visibleSec = clamp(T)        frozen = false
```

`window`（封榜时长）与默认开关的来源：

| 榜单文件 | `window` | 默认 `freezeEnabled` |
| --- | --- | --- |
| `frozenDuration` > 0 | 该值 | `true` |
| 显式 `frozenDuration: 0` | 60 分钟 | `false` |
| 无该字段 | 60 分钟（CCPC 惯例） | `true` |
| 网页填了分钟数 | 手填值 | 由勾选框决定 |

封榜是**每场 VP 可选**的显示设置，不是榜单文件的属性：任何比赛都可以勾选启用并指定时长。

**三个时间**

| 名称 | 含义 | 封榜时的行为 |
| --- | --- | --- |
| `contestSec` | 真实比赛时钟 | **继续走**（计时器与进度条正常） |
| `boardSec` | 榜单**结果**所描述的时刻 | 钉在 `frozenAt` |
| `pendingSec` | 提交计数所描述的时刻 | **继续走** |

**封榜时的榜单形态**（ICPC 经典封榜样式）：封榜隐藏的是**结果**，不是提交，也不是题号。

- **所有题号全部可见**（不受门限约束）；
- 未出结果的提交显示为**蓝色 `?N`**（`N` = 该队对该题的提交次数）；
- **`?N` 会随时间继续增长** —— pending 提交实时出现；
- 已 AC 的题照常显示绿色用时；
- 顶部每题的 `提交数` 继续增长，`过题数` 冻结在封榜时刻。

**解封**：比赛到达 `duration` 时自动解封；也可手动点「解封」。解封后 `visibleSec` 放开到真实时间，蓝色 `?N` 变回真实的绿/红结果。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 可见时间裁剪 | `shared/replay.mjs` → `resolveFreeze()`（纯函数） |
| 时长/开关的默认与来源 | `shared/live.mjs` → `createSession()` |
| 运行时改开关与时长 | `shared/live.mjs` → `setFreezeEnabled()` / `setFreezeMinutes()` |
| 自动解封判定 | `shared/live.mjs` → `isRevealed()` |
| 阶段状态机 | `shared/live.mjs` → `phase()`（`pending` / `running` / `frozen` / `ended`） |
| pending 提交的实时统计 | `shared/replay.mjs` → `submissionCountsAt()`、`submittedTeamsAt()` |
| 封榜时题号全显 + `?N` 单元格 | `web/board.mjs` → `aliasVisible()`、`cellContent({ frozen, pending })` |
| 界面徽标与按钮 | `web/app.mjs` → `renderBoard()` |

---

## 9. 奖项区（金 / 银 / 铜）

名次单元格按奖项区染色，**只给正式（official）队伍染**；非正式队伍名次显示 `—` 且不染。

**名额计算**

```
officialTeams = 当前榜单里的正式队伍数
若榜单文件的 ICPC series 显式给出 count（任一非 0）：
    每个奖项的 count 直接使用
否则（count 为 [0,0,0] 占位，或没有 count）：
    按 ICPC 区域赛惯例比例 ratio = [0.10, 0.20, 0.30]
    第 i 个奖项的边界 = ⌊officialTeams × (ratio[0..i] 之和)⌋
    count[i] = 边界[i] − 边界[i−1]
```

名额按**当前队伍数实时算**：队伍不变时它也不变，切换「是否仅官方队伍参与排名」时会重算。并列名次共享同一奖项区。

**实测**（2026 CCPC 网络预选赛，正式队伍 2166）：

| 奖项 | 名额 | 名次区间 |
| --- | --- | --- |
| 金 | 216 | 1 – 216 |
| 银 | 433 | 217 – 649 |
| 铜 | 650 | 650 – 1299 |

**实现**

| 步骤 | 位置 |
| --- | --- |
| 从 SRK 抽取奖项声明 | `server/build-timeline.mjs` → `extractAwards()` |
| 名额与边界 | `shared/rules.mjs` → `medalBands()` |
| 名次 → 奖项 | `shared/rules.mjs` → `medalFor()` |
| 每行附加 `medal` 字段 | `shared/rules.mjs` → `computeBoard()` |
| 染色与 tooltip | `web/board.mjs` → `renderRow()`；`web/ui.css` |

> 若榜单文件既无显式 `count` 也无 `ratio`，使用上面的 10/20/30 惯例 —— 这是 ICPC 区域赛的通行比例，但各赛区可能不同。改 `DEFAULT_MEDAL_RATIOS` 即可调整。

---

## 10. 规则变更时的修改清单

| 若官方调整… | 改这里 |
| --- | --- |
| 20% 或 50 队门限 | `DEFAULT_REVEAL_RATIO` / `DEFAULT_REVEAL_MIN`（`server/build-timeline.mjs`）与 `revealThreshold()`（`shared/rules.mjs`） |
| 计数范围（全部 vs 仅官方） | `createState()` 的 `revealScope`；界面默认值在 `web/index.html` |
| 顶部题号栏排序 | `problemStatus()` 里的 `order.sort(...)` |
| 免罚结果、罚时分钟数、时间精度 | 榜单文件的 `sorter.config.*`（自动生效）；默认值在 `shared/srk.mjs` |
| 封榜时长/开关的默认 | `createSession()`（`shared/live.mjs`）；界面在 `web/index.html` |
| 并列名次算法 | `computeBoard()` 的名次分配循环 |
| 金/银/铜比例 | `DEFAULT_MEDAL_RATIOS`（`shared/rules.mjs`），或让榜单文件带显式 `count` |

改完请跑 `npm test`，以及 `VP_E2E=1 npm run test:e2e` 确认真实数据仍然逐队一致。
