# 系统模式（System Patterns）

> 详细架构设计见 `docs/02-技术路线.md`。

## 总体架构：客户端-服务器，服务器权威
```
┌──────────┐   WebSocket    ┌───────────────────┐   WebSocket   ┌──────────┐
│ 浏览器 A  │ ◄────────────► │  Node.js 主机进程   │ ◄───────────► │ 浏览器 B  │
│ 输入上报  │   输入(上行)    │  · 房间/大厅管理     │  状态快照(下行) │ 输入上报  │
│ 快照渲染  │                │  · 60Hz 游戏模拟    │               │ 快照渲染  │
└──────────┘                │  · AI 机器人        │               └──────────┘
                            │  · 静态文件托管(HTTP) │
                            └───────────────────┘
```

## 关键设计决策
1. **服务器权威（Server Authoritative）**：单一大厅进程内嵌游戏模拟器；客户端是"哑终端"，只发输入、收快照。杜绝状态分歧，逻辑只写一份。
2. **固定时间步长模拟**：服务器以固定 60Hz tick 模拟世界；快照按 tick 序号广播，客户端缓冲 2~3 帧做插值渲染，消除网络抖动。
3. **输入驱动协议**：上行只传按键位掩码（1~2 字节），下行快照为**全量 JSON**（每 tick 广播；同一 tick 整包只序列化一次，支持 `Conn.sendRaw` 复用字符串；局域网内带宽充裕，优先简单可靠，必要时再切二进制）。
4. **逻辑与渲染分离**：`shared/` 纯逻辑模块（实体、碰撞、地图）不依赖 DOM/Node API，可被 Vitest headless 测试。
5. **状态机驱动流程**：客户端（Menu → Lobby → Playing，无独立 Result 状态，结算用覆盖层展示）与房间（Waiting → Countdown → Playing → RoundEnd）均为显式状态机，消息只允许合法状态迁移。
6. **稳定性不变量（2026-10-21 审查确立）**：① 出生点唯一分配（地图 8 个 spawns + `findFreeSpot()` 兜底）；② 一切半格吸附必须过 `trySnap()` 碰撞校验；③ 范围伤害（炸弹）尊重护盾；④ 广播只发已加入成员；⑤ HTTP 输入解析/读文件必须 try/catch + `path.relative` 防逃逸；⑥ 重连必须同步地图与完整地形（lobbyState.map/terrain）；⑦ tick 循环 onTick 异常跳帧继续（finally 重调度），连续异常过多才停止；⑧ L3 砖墙以命中砖格所属 2×2 大格为锚（四方向一致）；⑨ 静态资源（带扩展名）缺失/逃逸一律 404，不回落 SPA；⑩ WS 握手校验 Origin（同源或 localhost），maxPayload 4KB、连接上限 32。

## 组件关系
- `Room`（server/room.ts，房间管理 + 消息路由 + 托管/重连）
- `BattleSim`（单局模拟：实体、碰撞、道具、计分）+ `BotController`（shared/sim/bot.ts，AI）
- `main.ts` / `NetClient` / `SnapshotBuffer` / `TerrainView`（client/：连接管理、输入采集、快照插值、地形视图、渲染、音频）
- `MapLoader`（shared/map/loader.ts，JSON 关卡 ↔ 网格数据 + 严格校验）
