# CCPC 新榜单模式的规则形式化与实现对照

本文把 CCPC 新榜单模式（2026.9.14 整理版）的说明翻译成可执行的形式化描述，并逐条对应到代码位置与测试用例，便于日后规则微调时定位修改点。

**唯一权威实现**：[`shared/rules.mjs`](../shared/rules.mjs)。该模块不依赖 DOM 与网络，Node 与浏览器共用。

---

## 0. 术语与数据模型

来自 [Standard Ranklist](https://github.com/algoux/standard-ranklist)（v0.3.13）榜单文件：

| 概念 | 数据来源 |
| --- | --- |
| 队伍数 `N` | `ranklist.rows.length`（或其中 `user.official !== false` 的数量） |
| 题目数 `P` | `ranklist.problems.length` |
| **题目下标 `p`** | `problems[p]` 的数组下标。**这是题号的唯一身份**：`statuses[p]` 严格对应 `problems[p]`（已用官方 `statistics.accepted` 与逐列统计逐题比对确认） |
| 题目别名 | `problems[p].alias`（如 `A`、`B`，也可能是 `1-1`、`A*`） |
| 别名显示顺序 | 按 `alias` 字典序比较，实践中 `problems` 数组本身即按此序 |
| 提交事件 | `rows[team].statuses[p].solutions[]`，每条含 `result` 与 `time`，**按时间升序** |
| 结果聚合 | `rows[team].statuses[p].result` ∈ `AC \| FB \| RJ \| null`；`tries` 为有效提交次数 |
| 时长/罚时单位 | `[值, 'min'\|'s'\|'h'\|'ms'\|'d']` |
| 时间精度 | `sorter.config.timePrecision`（2026 年场次为 `"min"`） |
| 免罚结果 | `sorter.config.noPenaltyResults`（默认 `["FB","AC","?","NOUT","CE","UKE",null]`） |
| 封榜时长 | `contest.frozenDuration` |

**回放状态**（每队、每题各一份）：

- `acAt[team][p]`：该队首次 AC 该题的比赛秒数，未 AC 为 `-1`
- `tries[team][p]`：该队对该题的有效提交次数（**AC 之后的不计**）
- `lastSub[team][p]`：该队对该题**最晚一次有效提交**的比赛秒数，无提交为 `-1`
- `fails[team][p]`：其中计入罚时的失败次数
- `solved[team]`、`penalty[team]`、`lastAc[team]`

时间轴按比赛秒升序逐条应用（`applyEvent`）。对任意目标时刻 `T`，状态 = 所有 `time ≤ T` 的事件依次应用的结果；因此精确、可任意 `seek`，且与「从头重放」在位点上完全一致。

> 参考实现：`createState`、`applyEvent`、`replayTo`、`createEpochReplay`。
> 测试：`test/rules.test.mjs` 的 "only events at or before the limit are applied"、"createEpochReplay matches a full replay at every probe"。

---

## 1. 题号显示（说明文档第 1 条）

> 比赛初始时，榜单不显示各题题号；当某个题的 AC 队伍数达到 50（或者【队数的 20%】下取整），该题的题号将显示在榜单中。

**形式化**

```
R = min( ⌊N × ratio⌋ , min )               ratio 默认 0.2，min 默认 50
R = max(1, R)                              R 最小为 1，避免 R=0 时“零人过题即显示”
revealSec[p] = min{ t : |{ 已 AC 题 p 的计数队伍 }| ≥ R }
revealed(p, T) ⇔ T ≥ revealSec[p]
```

- **是 `min` 不是 `max`**：50 队是**上界**，`⌊N×20%⌋` 是实际门限。小比赛按 20% 揭示，大比赛封顶 50 队。
  早期版本误用 `max`，导致 2170 队的比赛门限变成 434 队、绝大多数题号几乎全场不可见。
  实测修正后 2026 CCPC 网络预选赛（2170 队）门限 = 50，题号随时间自然浮现。
- `N` 取**榜单队伍数**，可选「全部队伍」或「仅官方队伍」两种口径（网页可切换）。
- 计数单位是**去重的队伍数**，不是 AC 次数；**只统计 AC**，仅提交未过的不计入。
- 门限在比赛开始时确定（`N` 不随比赛进行变化）。
- 全场无人达到 `R` 的题（例如只有 1 支队伍通过的题）**始终不显示题号** —— 这是预期行为，不做兜底。

**关键点：揭示用的是「截至当前显示时刻的实时过题队数」。**
`problems[p].statistics.accepted` 是发布时的快照，实测可能与回放统计不同（该场 M 题：官方 423，回放 434）。所以：

- 运行时**不**读取预计算的 `revealSec`，而是由回放状态里的计数器 `CountedSolves` 逐秒求出实时值；
- 服务器预计算的 `reveal.all/official.revealSec` 只用于自描述、`/api/diagnose` 展示与回归测试断言。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 门限公式 | `shared/rules.mjs` → `revealThreshold()` |
| 实时过题队数计数 | `shared/rules.mjs` → `CountedSolves`、`applyEvent()` |
| 每帧实时状态（计数 / 是否揭示 / 列头顺序） | `shared/rules.mjs` → `problemStatus()` |
| 预计算（自描述 + 测试用） | `server/build-timeline.mjs` → `computeReveal()` |
| 单元格是否暴露别名 | `shared/rules.mjs` → `cellInfo().alias` |
| 界面呈现 | `web/board.mjs` → 列头未揭示显示 `?` 且不着色 |

**测试**：`test/rules.test.mjs` → "revealThreshold is the smaller of floor(N * 20%) and 50"、"1000-team fixture reveals at 50 solves, not 200"、"a problem is revealed exactly when the live count reaches the threshold"、"the official scope ignores unofficial solvers"；`test/e2e.test.mjs` → "reveal times follow the live accepted count"（真实数据上重算并与预计算逐一比对）。

---

## 2. 榜单不按统一题目顺序展示（说明文档第 2 条）

这是第 3 条的结论：**行内列顺序因队而异**，因此列位置不代表题目身份。

**实现**：`web/board.mjs` 中每行 `<tr>` 按该队自己的顺序重排单元格，并在 `td.dataset.prob` 上保存真实题目下标；
顶部题号栏（规则 5）**按实时过题数排序**，也不固定为题目下标顺序，因此同样不能由列位置推断题号。

---

## 3. 每队解题情况的题目顺序（说明文档第 3 条）

> ⚫ 先展示显示题号的题目，顺序为题号由小到大；
> ⚫ 再展示剩余题目中队伍已 AC 的，顺序为 AC 时刻由早到晚；
> ⚫ 再展示剩余题目，顺序为最晚一次提交时刻由早到晚，未提交过的题按题号（但不会显示）由小到大排在最后。

**形式化**：对队伍 `g`、时刻 `T`，把每题分到四个桶，按下表排序（桶优先级 → 桶内 key1 → key2）。

| 桶 | 条件 | key1 | key2 | 别名 |
| --- | --- | --- | --- | --- |
| `REVEALED` | `revealed(p,T)` | 题目下标 | — | **显示** |
| `SOLVED_HIDDEN` | 未揭示 ∧ `acAt[g][p] ≠ -1` | `acAt[g][p]`（AC 时刻升序） | 题目下标 | 隐藏 |
| `ATTEMPTED_HIDDEN` | 未揭示 ∧ 未 AC ∧ `tries > 0` | `lastSub[g][p]`（最晚提交升序） | 题目下标 | 隐藏 |
| `UNTOUCHED` | 其余 | 题目下标 | — | 隐藏 |

要点：

- 桶 1 是**所有已揭示的题**，含未 AC 的题（它们仍然显示题号）。
- 「剩余题目」= 未被桶 1 取走的题，所以桶 2/3 的题**必然未揭示**。
- 桶 3 的「最晚一次提交」**不含 AC 之后的提交**（见第 4 条）。
- 封榜时行内顺序**不变**：封榜只改「哪些题号可见」（全部可见）与「单元格怎么画」（蓝色 `?N`），`columnOrder()` 仍然按封榜时刻的 `acAt` / `lastSub` 计算，所以封榜期间顺序是冻结的、不会因新提交而跳动。
- 桶 4 中「题号不显示」，但排序仍按题号。
- 表格右侧格子内容（AC 时间、提交次数）**与别名是否显示无关**：未揭示但已 AC 的题会显示为绿色格子却不显示题号 —— 这正是新赛制「知道自己过了几题、不知道是哪题」的效果。

**降级**：旧格式榜单没有逐条提交时间，桶 3 的 `lastSub` 不可知 → 退化为按题目下标排序。桶 2 仍精确（`statuses[p].time` 给了 AC 时刻）。状态由 `timeline.coverage.exact` 标记，界面显示「排序降级」徽标。

**实现**：`columnOrder()`；桶常量 `BUCKET`；旧格式计数回退 `triesFallback`。
**测试**：`test/rules.test.mjs` → "columnOrder applies the four buckets in order"、"puts revealed problems first even if solved later"、"sorts hidden solves by AC time ascending"、"sorts un-solved attempts by latest submission ascending"、"puts never-submitted problems last, by problem number"、"uses the legacy fallback attempt counts"、"column order changes over time as problems are revealed"。

---

## 4. AC 后忽略该题的再次提交（说明文档第 4 条）

> 不管是否封榜，队伍 AC 某道题后，对该题的再次提交将被忽略，不会增加对该题的提交计数。

**形式化**：在 `applyEvent` 中，若 `acAt[g][p] ≠ -1`，该事件被**完全丢弃**：

- 不增加 `tries[g][p]`（界面显示的次数不变）
- 不更新 `lastSub[g][p]`（不影响第 3 条桶 3 的顺序）
- 不增加 `fails[g][p]`（不影响罚时）
- 不影响 `solved` / `penalty` / `lastAc`

该规则在**封榜前后都成立** —— 它是回放语义，与封榜是两个独立机制。

**实现**：`applyEvent()` 开头的提前返回。
**测试**："submissions after an AC are ignored entirely (rule 4)"、"a second AC on the same problem is ignored"。

---

## 5. 顶部题号栏（实时过题数与排序）

顶部每个**题目列**同时表达三件事：

1. **题号**：已揭示（或封榜中）显示别名（`A`、`B`…），未揭示显示 `?`；
2. **过题数 / 提交数**：截至**当前显示时刻**的去重统计，显示为 `AC/总提交`（例如 `285/286`）。两个数都从回放事件流统计，**不用** `statistics.accepted` 那个最终快照；
3. **底色**：仅在题号可见时着色（用 SRK 的 `problems[].style.backgroundColor`）；未揭示一律不着色，避免从颜色推断题号。

**排序**：永远按**实时过题数降序**，同数按题目下标升序。因此：

- 顺序**不固定**，随时间变化；每有队伍过题就可能改变；
- 封榜期间顺序也**冻结**（因为显示时刻被钉在封榜点）；
- 因为顺序会变，顶部列位置同样**不能**用来推断题号。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 实时计数 / 揭示集合 / 顺序 | `shared/rules.mjs` → `problemStatus()` 返回 `solved`、`aliasRevealed`、`order` |
| 每帧传入界面 | `shared/live.mjs` → `frame.stats` |
| 排序与着色渲染 | `web/board.mjs` → `renderHeader()`、`headerTitle()` |

**测试**：`test/rules.test.mjs` → "the header orders problems by live solve count, ties by number"、"the header order is stable for equal counts"、"the header re-sorts as counts change over time"、"createEpochReplay keeps solve counts correct when seeking backwards"；`test/board.test.mjs` → "headerTitle explains a hidden problem and reports live counts"。

---

## 5. 计分（ICPC 规则 + 时间精度）

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
- **两级取整都要做**：逐题用时先取整，累加后的总罚时再取整。实测 2026 网络预选赛必须如此才能与官方榜单逐队一致。
- `RJ`（被拒）结果**没有 `time` 字段**，因此天然不产生罚时；`CE`/`NOUT`/`UKE` 等在 `noPenaltyResults` 内，也不计罚时。

**实现**：`applyEvent()` 的 AC 分支；`floorToPrecision()`；免罚码集合 `noPenaltyCodes`（来自榜单文件的 `noPenaltyResults`）。
**测试**："a solve adds floored solve time plus 20 minutes per failed attempt"、"no-penalty results do not count as failed attempts"、"an RJ submission counts as a try but carries no penalty"、"floorToPrecision floors to the configured unit"。

---

## 6. 排名

**形式化**

```
排序 key：( -solved , totalPenalty , lastAc )
并列定义：solved 与 totalPenalty 都相同（lastAc 只用于决定先后，不拆开并列）
名次：竞赛排名 1, 1, 3, …（并列组共享其首行的名次，下一名次按位置跳过）
官方队：user.official === false 的队伍列出但不参与排名（名次显示 —）
```

**实现**：`compareRows()`（排序）、`computeBoard()`（名次分配）。
**测试**："ranking sorts by solves desc, penalty asc, then earliest last AC"、"teams tied on solves and penalty share a rank and the next rank skips"、"official:false teams are listed but never ranked"、"an unsolved board is all zeroes and still rankable"。

**与官方榜单的已知差异**：实测 RankLand 官方榜单在并列组内并不总按 `lastAc` 排序（例：2026 网络预选赛第 86/87 名，两队 `solved=9`、`penalty=42660`，官方把 `lastAc` 较大者排在前面）。本工具在并列组内按 `lastAc` 排序，故并列组内部顺序可能与官方略有差异，但**分数与名次结构完全一致**。e2e 回归断言到「每个名次上的 `(solved, penalty)` 与官方逐个吻合」。

---

## 7. 封榜与解封（说明文档第 5 条）

> 比赛最后 1 小时封榜，封榜后榜单显示与原 XCPC 模式相同。

**形式化**

```
usesFreeze = freezeEnabled ∧ window > 0
frozenAt   = duration − window

!usesFreeze          → visibleSec = clamp(T)
T ≤ frozenAt         → visibleSec = clamp(T)         frozen = false
T >  frozenAt ∧ 未解封 → visibleSec = frozenAt        frozen = true,  revealPending = true
T >  frozenAt ∧ 已解封 → visibleSec = clamp(T)        frozen = false
```

`window`（封榜时长）的来源，按优先级：

| 情况 | `window` | 默认 `freezeEnabled` |
| --- | --- | --- |
| 榜单文件 `frozenDuration` > 0 | 该值 | `true` |
| 榜单文件显式写了 `frozenDuration: 0` | 60 分钟 | `false`（尊重"本场不封榜"） |
| 榜单文件没有该字段 | 60 分钟（CCPC 惯例） | `true` |
| 网页上手填了分钟数 | 手填值 | 由勾选框决定 |

**封榜是「每场 VP 可选」的显示设置，不是榜单文件的属性**：任何比赛都可以勾选启用封榜并指定时长，包括那些榜单文件里 `frozenDuration` 为 0 的比赛。

**封榜时的榜单形态（ICPC 经典封榜样式）**

封榜隐藏的是**结果**，不是题号。因此封榜后：

- **所有题号全部可见**（不再受门限约束）；
- 未出结果的提交显示为**蓝色的 `?N`**（`N` = 该队对该题的提交次数），这就是「看得到交了、不知道结果」；
- 已经 AC 的题照常显示绿色的用时；
- 顶部每题的计数继续按**封榜时刻**显示（不再增长）。

以 `icpc2026invitational-shenyang`（时长 18000s，冻结 3600s）在 t=16000s 实测：

```
badge=已封榜   clock=4:00:00（= frozenAt）
header 13/13 题号全部可见：L:285/286  F:278/280  K:262/280  E:106/267  I:33/122 … M:0/8
cells  pending=20  failed=0  solved=181
pending 样例：?3@0  ?1@7  ?1@0  ?2@9
```

对照：**未封榜且未解封时**该场的题号只显示达到门限的那些，且 `?N` 不会出现（未 AC 的显示红色 `-N`）。

- **面板时间（`T`）与榜单时间（`visibleSec`）分离**：封榜期间真实比赛时钟继续走（`T` 继续增大），但榜单被钉在 `frozenAt`。界面显示的是**榜单时间**，避免"时钟在走、榜单不动"的错觉。
- 封榜期间：题号不再增加、过题数不再增长、行内顺序不再变化、顶部顺序冻结 —— 因为一切都从 `visibleSec` 的回放状态派生。
- **解封**有两种触发：比赛到达 `duration` 时**自动解封**；或手动点「解封」。解封后 `visibleSec` 放开到真实时间，蓝色 `?N` 变回真实的绿/红结果。

**实现**

| 步骤 | 位置 |
| --- | --- |
| 可见时间裁剪 | `shared/replay.mjs` → `resolveFreeze()`（纯函数） |
| 封榜时长/开关的默认与来源 | `shared/live.mjs` → `createSession()` |
| 运行时改开关与时长 | `shared/live.mjs` → `setFreezeEnabled()` / `setFreezeMinutes()` |
| 自动解封判定 | `shared/live.mjs` → `isRevealed()` |
| 阶段状态机 | `shared/live.mjs` → `phase()`（`pending/running/frozen/ended`） |
| 封榜时题号全显 + `?N` 蓝色单元格 | `web/board.mjs` → `aliasVisible()`、`cellContent({frozen})` |
| 界面徽标与按钮 | `web/app.mjs` → `renderBoard()` |

**测试**：`test/rules.test.mjs` → "resolveFreeze clips the board once the freeze starts"、"with reveal unlocks the true board"、"never freezes when the mode is never"、"is a no-op for contests without a freeze window"、"clamps beyond the contest duration"、"a freeze can be requested for a contest that declares none"、"an undeclared freeze length falls back to the 60-minute convention"、"the declared freeze length is adopted when present"、"the freeze length can be changed mid-VP"、"session goes through countdown, running, frozen and revealed"、"a frozen session stops reflecting new events, and unfreezing reveals them"、"a whole contest freezes, holds, then fully unfreezes at the end"；`test/board.test.mjs` → "a frozen board renders unresolved attempts as blue pending cells"、"pending cell counts every attempt the team made"。

真实数据核对：`icpc2026invitational-shenyang`（时长 18000s，冻结 3600s → `frozenAt = 14400`）：

```
t=14390   running  visible=14390  revealed=false
t=14410   frozen   visible=14400  revealed=false   榜单钉住
t=17995   frozen   visible=14400  revealed=false   真实时钟在走，榜单不动
t=18001   ended    visible=18000  revealed=true    自动解封，题号与计数全部放开
```

---

## 8. 气球（本版本未实现）

说明文档中的两种一血方案与每队专属颜色映射，已在数据结构层面预留：

- 结果码 `RESULT.FB`（`2`）已保留，`solutions[].result === 'FB'` 可直接识别一血。
- 题目颜色已随 `problems[p].color` 下发（`style.backgroundColor`）。
- 每队专属映射可用 `hash(teamId) + problemIndex` 做确定性置换，无需存储。
- 会话已记录 `pinnedTeamId` 的位置（`web/app.mjs` 的 `app.pinnedTeamId`、`web/board.mjs` 的 `setPinnedTeam`），后续接入「只显示自己队伍的气球」时不需要改动引擎。

---

## 9. 规则变更时的修改清单

| 若官方调整… | 改这里 |
| --- | --- |
| 20% 或 50 队门限 | `DEFAULT_REVEAL_RATIO` / `DEFAULT_REVEAL_MIN`（`server/build-timeline.mjs`） |
| 计数范围（全部 vs 仅官方） | `buildTimeline()` 中的 `teamCounted`；界面默认值在 `web/index.html` |
| 题目排序优先级 | `columnOrder()` 的桶定义与 key |
| 免罚结果集合 | 榜单文件的 `sorter.config.noPenaltyResults`（自动生效）；默认值 `SRK_DEFAULT_NO_PENALTY_RESULTS`（`shared/srk.mjs`） |
| 罚时分钟数 | `sorter.config.penalty`（自动生效） |
| 时间精度 | `sorter.config.timePrecision`（自动生效）+ `floorToPrecision()` |
| 封榜时长 | `contest.frozenDuration`（自动生效） |
| 并列名次算法 | `computeBoard()` 的名次分配循环 |
| 一血气球形态 | 见第 8 节（待实现） |

改完请跑：`npm test`，以及 `VP_E2E=1 npm run test:e2e` 确认真实数据仍然逐队一致。
