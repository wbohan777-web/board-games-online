# 项目交接文档 · 双桌游联机平台

> 森林拼图（Forest Shuffle）+ 光合作用（Photosynthesis），零第三方依赖，Node.js 单进程实时联机。
> 本文档面向接手开发者，包含架构、数据、测试、部署与已知注意事项。

---

## 1. 项目是什么

一个可自托管的双人/多人桌游联机平台。玩家在浏览器里填名字、建房拿四位房间码，朋友输房间码即可加入对局。服务端是纯 Node.js，没有 npm 依赖（连 WebSocket 都是手写的 RFC 6455 子集），因此没有 `node_modules`、没有构建步骤、没有供应链风险。

| 游戏 | 人数 | 规则实现度 |
|---|---|---|
| 森林拼图 Forest Shuffle | 2–5 人 | 基础包 + 高山 + 林地边缘，77 张卡全部效果接入 |
| 光合作用 Photosynthesis | 2–4 人 | 标准局（3 圈 18 回合），六角棋盘 + 太阳轮转 + 遮影 |

---

## 2. 目录结构

```
games/
├── server.js                  联机服务端（HTTP 静态 + 手写 WebSocket + 房间/回合/重连）
├── forest-shuffle/
│   ├── engine.js              规则引擎（抽牌/出牌/种树/四槽/冬卡终局/计分）
│   ├── effects.js             卡牌效果解析与执行器（immediate / bonus / persistent / Bedingung）
│   ├── cards.json             101 种卡牌的计分规则（只有计分，没有费用与效果）
│   ├── spec.json              77 张卡的费用、类型、牌堆结构、三种效果串
│   └── test.js                引擎测试（55 项）
├── photosynthesis/
│   ├── engine.js              规则引擎（六角/遮影/太阳/四动作/终局结算）
│   └── test.js                引擎测试（64 项）
├── public/
│   ├── index.html             大厅：填名字、选游戏、建房/加入
│   ├── forest.html            森林拼图棋盘与交互
│   ├── photo.html             光合作用 canvas 棋盘
│   └── shared.js              共享 WS 层（连接/重连/会话保持）
├── test-online.js             联机剧本端到端（57 项）
├── test-extraturn.js          额外回合确定性用例（14 项）
├── test-effects.js            效果层断言（52 项）
├── test-turnflow.js           回合流转与选择流（43 项）
├── test-fullgame.js           整局到终局结算（25 项）
├── test-browser.js            Chrome CDP 实机双开（35 项）
├── audit-effects.js           效果覆盖审计（应输出 unsupported: 0）
├── backfill-spec.js           一次性数据修复脚本（已执行，保留作记录）
├── package.json
├── Procfile                   web: node server.js
└── render.yaml                Render 部署配置
```

---

## 3. 快速启动

```bash
cd games
node server.js
```

默认监听 `0.0.0.0:8080`，可用环境变量覆盖：

```bash
set PORT=8091 && node server.js
```

浏览器打开 `http://127.0.0.1:8080`（或你设的端口），流程：填名字 → 选游戏 → 创建房间 → 得到 4 位房间码 → 朋友填名字 + 房间码加入 → 房主点开始。

断线后刷新页面会自动回到原房间，分数与棋盘保留（靠 `sessionStorage` 里的 pid 做会话恢复）。

---

## 4. 架构要点

### 4.1 服务端（server.js）

- **零依赖 WebSocket**：自己实现了 RFC 6455 的握手（`Sec-WebSocket-Accept` = SHA1(key + GUID) base64）、帧编解码、掩码处理。支持 126/127 长度分支。
- **房间模型**：`rooms: Map<code, room>`，房间内 `players: Map<pid, player>`。玩家用 `crypto.randomUUID()` 作 pid，重连时带上 pid 即可恢复座位。
- **状态裁剪**：森林拼图只给自己下发手牌（`hand`），对手只给数量（`handCount`）。光合作用全部公开。
- **回合流转**：`applyAction()` 统一分发。森林拼图有四种回合状态：
  - 普通：出牌后 `currentPlayer` 移交给下家
  - `extraTurn`（狼/熊的 Extrazug）：回合留在自己
  - `keepTurn` + `mode='anyPaid'`（鼹鼠）：可连续付费出牌
  - `keepTurn` + `mode='saplings'`（水鼠）：可连续放树苗
  - `turnMode='pending'`：打出牌触发了「免费放置」额度，回合压住等结算
- **健康检查**：`GET /healthz` 返回 `{"ok":true,"rooms":N,"games":[...]}`。

### 4.2 森林拼图引擎

**数据分成两份，这是最容易改错的地方：**

| 文件 | 内容 | 何时改 |
|---|---|---|
| `cards.json` | 101 种卡的**计分规则**（`scoring` 数组、`symbols`、`tags`、`zone`） | 调整某张卡怎么算分 |
| `spec.json` | 77 张卡的**费用**（`cost`）、**类型**（`types`）、**三种效果串**（`immediate`/`bonus`/`persistent`）、牌堆结构 | 调整费用或效果 |

运行时引擎把 `spec.json` 的效果合并成 `state.effectById` 索引，**所有费用与效果查询都走这个索引**。历史上两次重大 bug（全部免费、效果静默失效）都是因为误查了 `cards.json`。

**牌堆构成**：66 张树牌（`meta.treeCopies`）+ 56 张双面卡（`deck` 数组）= 122 张实体牌，加 3 张冬卡 = 125 张。冬卡洗进牌堆后 1/3 处，第三张出现立即终局。

**效果体系**（`effects.js`）：

- `parseEffect()` — 解析 `Effekt::` 串，27 种全部覆盖
- `runImmediate()` — 立即效果：抽牌、空地转移、清空空地、额外回合、保留回合、条件效果
- `parseBedingung()` / `evalCondition()` — 条件效果，如 `Bedingung(MinAnzTyp(1, Fledermaus), Effekt::Extrazug)`（场上有蝙蝠才给额外回合）
- `parsePersistent()` / `runPersistent()` — 持续效果，8 张蘑菇灌木：打出特定类型牌时抽 1；两棵蘑菇还要求挂在树的「下方」槽位
- 奖励效果（bonus）：支付的每张牌叶子符号都与主牌匹配才触发

**选择流**（`pendingFree`）：`EinsKostenlosAblegen` 系列不能自动结算，会落成额度，由 `actionPlayFree`（免费放置手牌）或 `actionTakeClearing`（从空地取指定类型牌）结算，额度用尽后回合才交出。

### 4.3 光合作用引擎

六角棋盘用轴向坐标 `(q, r)`，半径 3 = 37 格，四区按到中心距离分 4/3/2/1 片叶子（计分标记价值）。太阳 6 个方位每回合顺时针转一格，6 回合 = 1 圈，标准局 3 圈 = 18 回合。

**遮影判定**（`isShaded`）：影子从树出发沿太阳反方向延伸，长度等于树的等级（种子 0 / 小 1 / 中 2 / 大 3）。被遮挡的树不产光点，**除非它比遮挡者至少大一级**。

**开局前置阶段**：每人轮流在 1 叶区放 2 棵小树，并立即结算一次光合作用。没有这一步，第一回合所有人 0 光点，买不起种子，直接死锁。

---

## 5. 测试

七套测试，共 345 项断言，全部通过：

```bash
cd games
node forest-shuffle/test.js     # 55 项 引擎：抽牌/种树/四槽/计分/费用/奖励
node photosynthesis/test.js     # 64 项 引擎：六角/遮影/太阳/四动作/结算
node test-effects.js            # 52 项 效果：27 种串解析 + 8 张持续 + 条件正反向
node test-turnflow.js           # 43 项 回合：keepTurn / 免费放置 / 空地取牌 / 真实对局非零得分
node test-extraturn.js          # 14 项 额外回合确定性
node test-online.js             # 57 项 联机：房间/手牌隐私/断线重连/太阳轮转
node test-fullgame.js           # 25 项 整局：冬卡终局/排名广播/终局拒绝
node audit-effects.js           # 审计：应输出 unsupported / conditional: 0
```

浏览器实机测试（需要 Chrome）：

```bash
# 先启动服务
set PORT=8091 && set TEST_MODE=1 && node server.js
# 另开终端
node test-browser.js            # 35 项：真实浏览器双开，建房/出牌/扣费/奖励触发/太阳轮转
```

`test-browser.js` 通过 Chrome DevTools Protocol 驱动，会自己拉起两个独立 profile 的 Chrome 实例（端口 9222/9223/9224/9225/9226/9227）。如果端口被占用，先清理残留的 Chrome 进程。

---

## 6. 部署到 Render

仓库里已有 `render.yaml`，也可以手动建 Web Service：

1. 把 `games/` 目录推送到 Git 仓库
2. Render 新建 Web Service，root 目录设为 `games`
3. Build Command 填 `echo no build step required`（没有依赖要装）
4. Start Command 填 `node server.js`
5. 健康检查路径填 `/healthz`
6. 环境变量只需要 `NODE_VERSION=20`，`PORT` 由 Render 自动注入

部署完成后打开域名即可。**不要**设置 `TEST_MODE=1`。

---

## 7. 必须知道的注意事项

### 7.1 `TEST_MODE` 与 `debug_inject`

`server.js` 里有一条测试专用路径 `debug_inject`，可以把指定卡牌直接塞进玩家手牌，用于构造确定性测试场景（比如验证奖励效果正向触发）。它**只在环境变量 `TEST_MODE=1` 时生效**，否则收到该消息直接返回、不做任何事。生产部署不要设这个变量。

### 7.2 数据文件不要合并

`cards.json` 和 `spec.json` 是两份互补数据，不要试图合并或互相替代。改效果去 `spec.json`，改计分去 `cards.json`。

### 7.3 效果串是德语

`spec.json` 里的效果串（`Effekt::KartenZiehen(1)` 等）直接来自 Rust 开源实现（mischwald），`effects.js` 负责解析。`TYPE_MAP` 把德语类型名映射到英文 symbol（`Pfotentier → pawedAnimal`、`Fledermaus → bat` 等）。新增卡牌时注意类型名必须走这个映射。

### 7.4 回合状态的清理时机

`turnMode` 和 `pendingFree` 在三种情况下必须清空：普通出牌推进回合时、玩家主动 `endTurn` 时、额度结算完毕交出回合时。改动 `applyAction` 的 play 分支时，留意别让额度泄漏到下一回合。

### 7.5 手写 WebSocket 的限制

只实现了文本帧（opcode 0x1）、掩码解码、分片不做聚合。如果未来要传二进制或超大消息，需要扩展 `decodeFrames()`。

---

## 8. 已知未实现（明确的范围外）

- **光合作用「重度阴影」变体**：官方可选变体规则，标准局不需要
- **卡面美术资源**：目前全部是文字渲染，没有图片素材。要加美术需要引入图片资源并在 `public/` 三个页面里替换渲染逻辑
- **AI 对手**：只能真人联机，没有机器人

---

## 9. 数据来源

- 规则：Board Game Arena 官方规则摘要（两款游戏均为 Blue Orange 授权）
- 森林拼图卡牌计分：`forest-shuffle-calculator` 开源项目
- 森林拼图牌堆、费用、效果：`mischwald` Rust 实现（德语卡名）
- 德语到英语 id 的映射：`spec.json` 各卡片的 `ident` 字段

---

## 10. 交接检查清单

接手后建议按这个顺序验证一遍：

```bash
cd games

# 1. 语法与审计
node --check server.js
node audit-effects.js          # 必须输出 unsupported / conditional: 0

# 2. 跑全部单元与集成测试
node forest-shuffle/test.js
node photosynthesis/test.js
node test-effects.js
node test-turnflow.js
node test-extraturn.js
node test-online.js
node test-fullgame.js

# 3. 起服务手工玩一局
set PORT=8080 && node server.js
# 浏览器开两个窗口，各填名字，一个建房一个输房间码加入
```

七套测试全绿 + 手工能建房出牌，说明环境完整可用。
