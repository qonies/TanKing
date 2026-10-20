# 当前工作上下文（Active Context）

## 当前阶段
**M4 多人体验完成（2026-10-20）**：69/69 测试通过，`tsc --noEmit` 0 错误。M1~M4 完成（单机核心 / 联机打通 / 内容完整 / 多人体验）。下一步 M5 打磨发布。

## 已确认的关键决策
1. 核心玩法：**PvP 死亡竞技**（用户选定）。
2. 内容范围：**完整保留原版元素** —— 地形、道具、可破坏基地、AI 机器人填充（用户选定）。
3. 联机方式：局域网 WebSocket，服务器权威（已评审）。
4. 版权：自制/CC0 素材，不复刻原版 ROM 资源。
5. 六个决策点 D1~D6（用户 2026-10-19 确认，默认方案基础上 v0.3 修订）：D1 回合胜负改**积分制**（1 击杀 = 100 分，默认 1000 分/8 分钟可配）、D2 基地为**全局唯一中立基地**（摧毁者 +500 分不结束回合）、D3 **总坦克数上限 8（真人 + AI 合计）**默认 6、D4 房间聊天+游戏内快捷短语、D5 60Hz tick、D6 被击毁降 1 级。详见 `docs/01-需求文档.md` §5。
6. 2026-10-19 文档审查修订（v0.3）：地图 JSON `size` 注明为小格数（26 小格 = 13 大格）、铁锹改为加固中立基地、炸弹改为消灭全图、渲染图层顺序修正（水面移至坦克层下）、内置地图定为 6 张、FR-N6 UDP 发现移出本期、术语区分主机（Host）/房主（RoomOwner）。

## 当前任务
- [x] 建立记忆库
- [x] 编写 `docs/01-需求文档.md`、`docs/02-技术路线.md`、`docs/03-测试文档.md`
- [x] 用户评审通过，D1~D6 采用默认方案，文档已更新为 v0.2
- [x] 文档审查完成，8 项问题按用户裁决修订（积分制/中立基地/上限 8），文档更新为 v0.3
- [x] **M1 单机核心**（2026-10-19）：
  - 脚手架：Vite + TypeScript + Vitest（`npm run dev/test/build`）
  - `shared/`：constants（参数集中管理）、types、rng（mulberry32）、map/loader（兼容 13×13 大格自动展开）、`sim/BattleSim`（60Hz 固定步长：半格吸附移动、AABB 碰撞、砖/钢/水/树/冰、子弹互消、击杀计分、护盾/重生、积分上限/限时胜负）、`sim/BotController`（BFS 寻路 + 对齐瞄准 + 卡墙开火开路）
  - `maps/map01.json`：26×26 对称地图（2 出生点，含全部 5 种地形）
  - `client/`：键盘输入（位掩码）、Canvas 分层渲染（占位色块）、HUD 计分板/击杀播报、固定步长主循环、R 重开
  - `tests/`：29 个用例全绿（移动吸附/碰撞/冰面/砖钢水树/子弹互消/计分/护盾/胜负/BOT 行为/可复现性）
  - `docs/参数对照表.md` 已建立（M1 近似项已标注，M3 需逐帧精调）
- [x] **M1 收尾与发布准备**（2026-10-19）：文档一致性修订（状态行/冰面滑行/协议措辞）、SCORE_CAP_DEFAULT 统一引用、魔数改常量（CELL/TANK_SIZE）、修正砖墙条带测试恒真断言、新增 README.md 与 MIT LICENSE、git init + 首次提交（仓库级中性提交身份防隐私泄露）
- [x] **发布到 GitHub**（2026-10-19）：`gh repo create TanKing --public` 创建公开仓库 https://github.com/qonies/TanKing 并推送 main（c2c1acd）。注意事项：① 直接 `git push` 会超时（网络慢），需后台进程推送；② HOME 环境变量异常指向 /home/tony 导致 `gh auth setup-git` 失败，已改用**仓库级** `credential.helper "!gh auth git-credential"` 解决。
- [x] **审查修复**（2026-10-19）：文档↔代码交叉审查发现 4 项问题并修复：
  1. **默认 8 分钟限时未生效**：`main.ts` 现传入 `timeTicks: ROUND_TICKS_DEFAULT`；index.html 帮助文案同步（PRD D1 承诺的 1000 分/8 分钟）。
  2. **击杀记账去除 id==下标隐式依赖**：`BattleSim` 新增私有 `tankById()`，`killTank` 与 `main.ts` 事件处理均按 id 查找（M2 房间玩家进出安全）。「子弹存活于射手死亡后」已作为明确设计决策记入参数对照表 §3 第 6 条（原版行为 M3 核定）。
  3. **子弹互消改标记式**：旧代码边遍历边 splice，三弹同 tick 重叠时漏判；现用 dead Set 标记后统一过滤，一弹与多弹重叠全部抵消。
  4. **`findSpawn` 兜底防重叠**：200 次随机尝试全败后增加全场顺序扫描（确定性、不消耗 PRNG），保证重生点不与其他坦克重叠。
  另：爆炸事件残留魔数 `+4` 改 `BULLET_SIZE/2`；README/PRD 状态行「M2 开发中」改「待启动」；techContext dev 脚本标注 M2 目标。新增 3 个回归测试（三弹互消/死者子弹仍命中记账/重生不重叠），32/32 全绿。
  - **遗留未修**：测试文档覆盖率目标未落地（需 @vitest/coverage-v8 + coverage 配置）；地图 loader 未校验 spawns 越界/`def.size` 一致性；HUD innerHTML 拼名字的 XSS 隐患（M2 接入网络昵称前必须改 textContent）。
- [x] **M2 联机打通**（2026-10-19，当前阶段）：
  - 依赖：`ws` + devDeps `@types/ws` `@types/node` `tsx` `concurrently`；version 0.2.0
  - `shared/protocol.ts`：C2S（join/input/start）/ S2C（welcome/lobbyState/snapshot/event/error）消息类型
  - `server/room.ts`：Room 状态机 Waiting→Countdown(3s)→Playing→RoundEnd(5s)→Waiting；**Conn 抽象可注入**（测试无需真实 socket）；房主 = 最小 connId；真人优先 AI 补位（maxTanks 默认 2）；昵称 trim/≤12 字符/满员拒收
  - `server/gameLoop.ts`：setTimeout(1) 忙等 + 累积器 + 250ms 追帧上限；`server/index.ts`：HTTP 静态托管 dist + `ws` 同端口 `/ws`，坏 JSON 忽略
  - `client/net.ts`（NetClient）+ `client/interp.ts`（SnapshotBuffer 最新 tick−2 双帧插值，瞬移 >64px 不插值；TerrainView 应用 brickBreak 事件）
  - `client/main.ts` 重构：菜单（单机/联机）→ 大厅（成员/房主开始按钮）→ 倒计时 → 对局（输入变化时发送 + 15 tick 心跳）→ 结算回房间；renderer 改为 RenderView 抽象（单机传 sim、联机传插值视图）；昵称渲染全部 textContent（XSS 隐患已消除）
  - vite dev 代理 `/ws` → ws://localhost:3000；tsconfig include server + node types
  - 测试：tests/server.test.ts 9 个 L2 集成用例（join/lobby、满员拒绝、非房主不可开局、快照下发与输入驱动、AI 补位、限时结算回 Waiting、断线、非法消息、快照契约），总计 41/41
  - 冒烟验证：HTTP 200、WS join→welcome+lobbyState、双人开局→快照 ~60Hz 下发（12s 内 539 帧）
  - **M2 遗留到 M4**：断线 AI 托管/重连接管（FR-N4）、聊天（D4）、房间配置（FR-N3）、8 坦克上限、输入限流（NFR-6 完整版）
- [x] **M3 内容完整**（2026-10-19，当前阶段）：
  - **等级系统（FR-T3/T4/D6）**：`BULLET_SPEED_BY_LEVEL=[4,8,8,8]`、`MAX_BULLETS_BY_LEVEL=[1,1,2,2]`、L3 破钢（destroySteel）+ 砖墙整大格（destroyBrickStrip 深度扩展）、killTank 降 1 级；同主子弹不互消（L2 双发前提）
  - **六种道具（FR-P1~P6）**：PowerupType（Star/Helmet/Timer/Bomb/Shovel/Tank）；powerupSpots 定点刷新（20s 间隔、在场 ≤1、被占跳过）；满级星星 +100；定时器冻结 8s（不可移动/开火/拾取）；炸弹全图击毁按归属计分；铁锹基地环变钢 15s（shovelBackup 首次激活备份到期恢复，防重复备份污染）
  - **中立基地（FR-M6/D2）**：地图 base 字段（32×32 大格对齐，loader 校验）；bulletVsBase +500 分不结束回合；canOccupy 阻挡坦克；摧毁后可通行
  - **协议/快照扩展**：SnapshotTank + level/frozenTicks；Snapshot + powerups/baseAlive；S2C 新增 `start{map}`；房间地图按局轮换（maps 数组 + mapIndex）
  - **客户端**：client/audio.ts（Web Audio 合成 5 类音效，按钮点击 unlock）；renderer 基地/道具/冻结覆盖绘制；HUD 等级 ★n 与冻结状态；单机随机 6 图、联机按 start.map 重建 TerrainView
  - **地图**：scripts/gen-maps.cjs（13×13 大格模式 ×2 展开 + 点位合法性校验）生成 map02~06 + 修补 map01 基地环（6×6 砖圈完整包围）
  - **测试**：tests/m3.test.ts 15 例（升级链/满级星星/双发/弹速/L3 破钢整格/降级/头盔/定时器/炸弹/坦克/铁锹恢复/基地摧毁计分/实体障碍与通行/6 图注册表），总计 56/56
  - **冒烟**：HTTP 200 + 单人开局 + start 消息地图名 + 快照含 baseAlive/powerups（240 帧）
  - **M3 遗留到 M4**：AI 抢道具（困难档）、闪红 AI 掉落道具、旋律类音频（开场/结算/BGM）
- [x] **M4 多人体验**（2026-10-20，当前阶段）：
  - **审查修复（M4 前置）**：① `Room.join` 对局中拒绝新玩家（防幽灵玩家，仅同名断线成员可重连）；② `BotController` 改用 `sim.tankById()` 寻址（消除 id===下标隐式依赖）；③ 地图 loader 校验 `size` / 出生点越界 / 基地越界；④ `powerupCd` 冷却恒定流转（满员跳过不再重置计时）；⑤ 文档一致性（index.html 标题、package.json 0.4.0、README、参数对照表状态更正）
  - **8 坦克房间 + 房主配置（D3/FR-N3）**：maxTanks 默认 6、上限 8、clamp 2~8；C2S `config`（仅房主、仅 waiting/roundEnd）设置人数与 AI 难度；lobbyState 携带 maxTanks/botDifficulty
  - **AI 三档难度（FR-A3）**：easy/normal/hard 射速与命中率分档（已有）+ 困难档新行为：抢道具（无对枪机会时 BFS 逼近场上道具）、护家（优先攻击基地 4 格内敌人）；`bfsDir` 泛化为任意目标点（注意：目标需 clamp 到 0..N-1，否则 BFS 回溯死循环——本次教训）
  - **断线托管（FR-N4）**：对局中断线 → 成员保留标记 offline、坦克由 BotController 托管；60s 内同名 join 接管原坦克（撤销托管）；超时/结算未归来判离场（坦克永久 AI 代打）；房主 = 在线成员最小 connId
  - **聊天（D4）**：C2S/S2C `chat`（成员限定、trim、≤60 字）；客户端大厅聊天框 + 对局中 1~5 快捷短语（对局内消息进击杀播报 feed）
  - **键位自定义（FR-S1）**：`client/input.ts` 支持每动作自定义主键（localStorage 持久化 `tanking-keybinds`），WASD/J 固定备用键；主菜单键位设置面板（点按捕获改键、冲突回落）
  - **限流（NFR-6）**：Room 按秒窗口限流 120 消息/连接，超限静默丢弃
  - **测试**：tests/m4.test.ts 13 例（loader 校验/对局中拒 join/重连接管/超时离场/结算清理/房主配置/聊天/限流/困难档抢道具）；server.test.ts 断线用例改为托管语义并显式传 maxTanks:2，总计 69/69
- [ ] **M5 打磨发布**（下一里程碑）：原版参数逐帧核定（参数对照表 ⚠️ 项）、AI 速度档位、闪红 AI 掉落、旋律类音频、覆盖率工具（@vitest/coverage-v8）、性能验证、部署脚本

## M1 实现要点（后续开发需遵守）
1. **输入统一为位掩码**：`INPUT_UP=1/DOWN=2/LEFT=4/RIGHT=8/FIRE=16`（不是 `1<<Dir`！），真人与 AI 都走 `sim.setInput(id, mask)`。
2. **事件队列必须用 `drainEvents()`**（返回副本）；`TankState` 暴露给渲染层。
3. **地图 JSON**：26×26 字符矩阵（`. B S W T I`），spawns 单位为小格坐标；loader 兼容 13×13 自动展开。
4. **tank 位置对齐约定**：非移动轴恒为 16px 整数倍（转向/松开时吸附）；碰撞检测用内缩 0.01px 的 AABB。
5. **构建链**：`tsc --noEmit` 有 `noUnusedLocals/Parameters`，测试文件导入注意清理。
6. **编辑器写文件勿用 PowerShell Set-Content 处理含中文的 UTF-8 文件**（会乱码），统一用编辑工具。
