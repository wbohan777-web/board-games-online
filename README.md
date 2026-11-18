# 双桌游联机平台

森林拼图（Forest Shuffle）+ 光合作用（Photosynthesis）的实时联机实现，纯 Node.js，零第三方依赖，没有构建步骤。

## 玩法

- **森林拼图**（2–5 人）：抽牌或出牌，种树、把动物挂到树的四个槽位，用冬卡计时——第三张冬卡出现立即结束，比谁的分高。
- **光合作用**（2–4 人）：六角棋盘，太阳每回合转一格，树影遮挡采光；用光点买树、种种子、长大、采计分标记，三圈太阳后结算。

## 启动

```bash
cd games
node server.js
```

默认监听 `0.0.0.0:8080`，可用 `PORT` 环境变量覆盖。浏览器打开 `http://127.0.0.1:8080`。

联机流程：填名字 → 选游戏 → 创建房间得到 4 位房间码 → 朋友填名字和房间码加入 → 房主开始。断线刷新会自动回到原房间。

## 部署

仓库自带 `render.yaml`、`Procfile`、`package.json`。Render 新建 Web Service，root 设为 `games`，健康检查路径 `/healthz`，无需安装依赖。

## 测试

```bash
cd games
node forest-shuffle/test.js     # 55 项
node photosynthesis/test.js     # 64 项
node test-effects.js            # 52 项
node test-turnflow.js           # 43 项
node test-extraturn.js          # 14 项
node test-online.js             # 57 项
node test-fullgame.js           # 25 项
node audit-effects.js           # 效果覆盖审计
```

浏览器实机测试需要先以 `TEST_MODE=1` 启动服务，再运行 `node test-browser.js`（35 项）。

七套测试合计 345 项断言，全部通过。

## 深入文档

架构、数据结构、回合流转、注意事项与交接清单见 [HANDOFF.md](./HANDOFF.md)。
