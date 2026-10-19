# 当前工作上下文（Active Context）

## 当前阶段
**M1 完成 + 审查修复（2026-10-19）**：M1 完成（32/32 测试通过）。已完成文档一致性修订、README 与 MIT LICENSE、git 初始化与首次提交、发布 GitHub，并完成一轮文档/代码交叉审查修复。

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
- [ ] **M2 联机打通**（下一里程碑，等待用户指令）

## M1 实现要点（后续开发需遵守）
1. **输入统一为位掩码**：`INPUT_UP=1/DOWN=2/LEFT=4/RIGHT=8/FIRE=16`（不是 `1<<Dir`！），真人与 AI 都走 `sim.setInput(id, mask)`。
2. **事件队列必须用 `drainEvents()`**（返回副本）；`TankState` 暴露给渲染层。
3. **地图 JSON**：26×26 字符矩阵（`. B S W T I`），spawns 单位为小格坐标；loader 兼容 13×13 自动展开。
4. **tank 位置对齐约定**：非移动轴恒为 16px 整数倍（转向/松开时吸附）；碰撞检测用内缩 0.01px 的 AABB。
5. **构建链**：`tsc --noEmit` 有 `noUnusedLocals/Parameters`，测试文件导入注意清理。
6. **编辑器写文件勿用 PowerShell Set-Content 处理含中文的 UTF-8 文件**（会乱码），统一用编辑工具。
