# 进度（Progress）

## 状态
**M1~M5 完成 + 两轮审查修复（2026-10-21）**：version 0.6.1，**121/121 测试通过**（9 文件），`tsc --noEmit` 0 错误，覆盖率实测 92.1%（sim 96.5% / room 99.4%），性能验证达标（全链路 tick avg ≈0.013ms / 快照 1.44KB，口径含 AI 决策与序列化）。第二轮审查修复落地：断线自动重连（FR-N4 客户端侧 ≤3 次自动 + 昵称会话持久化 + 同名接管）、本机坦克航位推算（NFR-2 延迟预算 35~50ms）、单机/联机 Esc 与 HUD「返回主菜单」、大厅小窗口滚动布局（1x 缩放不溢出）、倒计时阶段 Tab 计分板可见（z-index）、FR-N3 配置范围服务端强校验（scoreCap 300~5000 / roundMinutes 1~30）、结算阶段断线保留席位、自定义键位冲突改「交换」、WS Origin 回环限定收紧（抽出 `server/origin.ts`）。**发布验收口径：功能完成；正式发布以 L4 真机联机清单执行完毕为准。**

## 里程碑规划
- [x] **M0 规划**：需求文档、技术路线、测试文档（已完成并评审确认，D1~D6 采用默认方案）
- [x] **M1 单机核心**（2026-10-19）：
  - shared/sim：60Hz 固定步长 BattleSim（半格吸附移动、AABB 碰撞、5 种地形、砖墙小格破坏、子弹互消、击杀 +100 计分、3s 护盾、2s 重生、积分上限/限时胜负）
  - AI：BotController（BFS 寻路 + 视线瞄准开火 + 卡墙开路，easy/normal/hard 参数已预留）
  - client：Canvas 分层渲染（占位色块）+ 键盘输入 + HUD + 击杀播报 + R 重开；`npm run dev` 离线可玩
  - maps/map01.json（26×26 对称地图）；tests 29 例全绿；docs/参数对照表.md
- [x] **M2 联机打通**（2026-10-19）：WebSocket 服务器（HTTP 同端口）、房间状态机、快照同步 + 客户端插值、AI 补位；L2 集成测试 9 例，总计 41/41；真实服务器双人开局冒烟通过
- [x] **M3 内容完整**（2026-10-19）：四级坦克、六种道具、中立基地、Web Audio 音效、6 张地图；tests/m3.test.ts 15 例，总计 56/56；冒烟通过
- [x] **M4 多人体验**（2026-10-20）：8 坦克房间（默认 6 可配 2~8，房主设置）、AI 三档难度（困难档抢道具/护家）、大厅聊天 + 快捷短语、键位自定义、断线 AI 托管与 60s 重连接管、消息限流；另修复审查发现 4 项缺陷（对局中幽灵玩家/Bot 下标寻址/地图校验/道具冷却）；tests/m4.test.ts 13 例，总计 69/69
- [x] **稳定性审查修复**（2026-10-21）：文档↔代码全面审查发现 3 项 P0（出生点重叠卡死/吸附推进卡死/畸形 URL 打崩 HTTP）、6 项 P1（炸弹无视护盾、maxTanks 超员、重连无地图地形同步、铁锹钢墙不可见、结算被大厅覆盖、广播泄漏到未加入连接）与多项 P2；全部修复并新增 tests/fixes.test.ts 20 例（总计 89/89）。6 张地图出生点补足 8 个、map01 基地清树、loader 强化校验、协议扩展（deaths/terrainSet/roundResult/map+terrain 重连同步）、Vite host、prestart 检查；文档（PRD v0.4/技术路线/测试文档/参数对照表/README）与记忆库同步更新。
- [x] **M5 打磨发布**（2026-10-21，当前阶段）：
  - **AI 速度档位**（参数对照表 §2）：`BOT_SPEED_BY_DIFFICULTY`（easy 0.75 / normal 1.0 / hard 1.5 px/tick）；`Tank.speed`（PlayerDef.speed 注入，缺省 TANK_SPEED）；Room 按 botDifficulty 为补位 AI 注入
  - **闪红 AI 掉落**（FR-P 适配）：`PlayerDef.bonus`（Room 以 seed+7777 确定性 rng 按 BONUS_BOT_PROBABILITY=0.2 标记）；killTank 原地掉落随机道具（与既有道具重叠跳过）；快照 SnapshotTank + bonus；客户端红色闪烁渲染
  - **旋律音频**（client/audio.ts 重构）：音效/音乐双 GainNode 独立音量（localStorage `tanking-volume` 持久化）；jingle('start'/'gameOver') 原创旋律；前瞻调度循环 BGM（原创 8-bit 循环，规避原版版权）
  - **房主地图选择（FR-N3）**：C2S config.map（房主限定、waiting/roundEnd、非法名回落随机轮换）；lobbyState + selectedMap；大厅地图下拉框 + 预览画布（FR-U2，renderer.drawMapPreview）
  - **音量与整数缩放（FR-S2）**：主菜单音效/音乐滑杆；applyScale() 1x~3x 整数缩放自适应窗口（预留 HUD 264px）
  - **Tab 计分板（FR-U3）**：对局中按住 Tab 显示完整排名表（单机 sim / 联机快照 + 大厅昵称）
  - **覆盖率工具**：@vitest/coverage-v8 + vitest coverage 配置（阈值 lines 85/functions 80），`npm run test:coverage`，实测 91.3%（sim 96.1%）达标
  - **性能验证**：scripts/perf.ts（8 坦克 6 AI × 6 图 × 60s），平均 tick 0.0021ms（预算 16.67ms）、快照 1.42KB（8 连接 ≈0.67MB/s），`npm run perf`
  - **部署脚本**：scripts/deploy.cjs（构建检查 + 局域网地址打印）、scripts/firewall.ps1（netsh 放行 TCP 3000，幂等），`npm run deploy` / `npm run firewall`
  - **测试**：tests/m5.test.ts 9 例（速度三档/速度缺省/闪红掉落 3 例/地图选择 3 例/快照 bonus），总计 98/98；冒烟 HTTP 200；vite build 通过
  - **文档同步**：PRD v0.5、参数对照表 M5 结论（逐帧比对定为发布后可选增强、近似项定稿）、测试文档（覆盖率实测/E2E 缓行说明）、README、version 0.5.0
- [x] **发布前复审修复**（2026-10-21，当前阶段）：文档↔代码复审全量修复，112/112 全绿，version 0.6.0——
  - 阻断项：L3 砖墙右/下方向整格摧毁失效（改为命中砖格大格锚定）、回合结算画面被大厅遮挡（overlay z-index）+ 完整排名与 MVP、tick 循环异常后永久停摆（gameLoop 容错 + server error 处理）、测试依赖 dist 不可复现（HTTP 用例改临时目录）。
  - 需求补齐：FR-N3 回合规则（积分上限/时长）与道具开关全量配置、FR-U3 HUD 回合倒计时（快照 ticksLeft）、FR-U4 结算全排名 + MVP、FR-O1 单机坦克数/AI 难度配置、FR-A2 AI 概率性攻打基地、履带声（PRD §4）。
  - 健壮性：loader 出生点矩形/基地重叠校验、铁锹贴边越界修复、Room 入参与配置守卫、lastInputTick 清理、WS Origin 校验/maxPayload/连接上限、HTTP 异步 + 资源 404 语义、快照帧间分数插值、perf 计时口径修正（avg 0.015ms 含 AI+序列化）、构建戳记 + deploy 总是重建、tsx 移入 dependencies。
  - 文档：PRD v0.6 / 技术路线 v0.4 / 测试文档 v0.4 / 参数对照表（定稿 + §4）/ README / memory-bank 同步；真实服务器冒烟（HTTP 200 / 同源 join / 跨源 401）通过。
- [ ] **发布后可选增强**（不阻塞发布）：E2E Playwright（浏览器下载受环境限制）、FC 模拟器逐帧像素比对、正式像素素材（sprite sheet）、FR-T4 等级移动速度差异档、L4 手工联机清单执行
- [x] **第二轮审查修复**（2026-10-21，当前阶段）：文档↔代码全面复审后修复 9 项，121/121 全绿，version 0.6.1——
  - **P1**：① 断线自动重连（client/main.ts：`onClose` → ≤3 次、间隔 1s 自动以会话昵称重连，覆盖层显示进度；`sessionStorage` 持久化昵称，刷新可同名接管）；② NFR-2 延迟预算（client/interp.ts：本机坦克在最新快照上沿移动方向外推 ≤1 tick 的航位推算，其余坦克保持 2 帧插值；技术路线 §4.3 补延迟预算表）；③ FR-N3 配置范围强校验（room.ts：scoreCap 300~5000 / roundMinutes 1~30 夹取，PRD 口径对齐）；④ 单机/联机 Esc + HUD「返回主菜单」（确认后退出，修复对局中无法改配置/回菜单）；⑤ 大厅 `#menu/#lobby` 面板内滚动 + 自动外边距居中（1366×768 / 1x 缩放下不再溢出画布）；⑥ 倒计时阶段 Tab 计分板可见（`#scoreboard.show` z-index 6 > overlay 5）。
  - **P2**：⑦ 结算（roundEnd）阶段断线保留席位、同名可接管（room.ts removeConnection/join 条件扩展）；⑧ 自定义键位冲突改「交换」语义（input.ts，修复重复绑定导致动作不可达；删除未用的 FALLBACK_BINDS）；⑨ `lobbyState.ticksLeft` 与快照口径统一（不限时 = null）；⑩ 单机地图 R 重开保持同一张（进入单机时才随机换图）；⑪ gameLoop 用例 `vi.spyOn(console,'error')` 静音（修复 PowerShell 下 stderr 误报失败）；⑫ `tsconfig` include `scripts`（perf.ts 纳入类型检查）；⑬ WS Origin 校验收紧并抽出 `server/origin.ts`（回环 Origin 仅在请求 Host 也为回环时放行，防本机其他端口页面跨站连接）；⑭ 快照事件残留 `renderer.clearFx()`。
  - **测试**：新增 9 例（fixes：配置范围夹取 / roundEnd 重连 / Origin 2 例；新增 tests/client-interp.test.ts：航位推算 3 例 + TerrainView 2 例），总计 112 → 121。
  - **文档同步**：PRD v0.7（FR-N3 强校验 / FR-N4 自动重连 / FR-T4 标注 / 发布验收口径）、技术路线 v0.5（目录树、§4.3 延迟预算与自动重连、素材章节）、测试文档 v0.5（DoD 口径、L4 清单）、参数对照表 §4（9 行二轮修复记录）、README（状态/操作说明/联机说明）；memory-bank 同步。
  - **验证**：tsc 0 错误、121/121、覆盖率 92.1%、perf avg ≈0.013ms / 1.44KB、`npm run build` 通过、真实服务器冒烟（HTTP 200 / 资源 404）通过。

## 已完成
- 记忆库建立（projectbrief / productContext / techContext / systemPatterns / activeContext / progress）
- 三份文档 v0.2：`docs/01-需求文档.md`、`docs/02-技术路线.md`、`docs/03-测试文档.md`
- 决策点 D1~D6 全部确认（默认方案），文档相应"待确认"标注已清除
- 2026-10-19 文档审查：8 项问题按用户裁决修订并升级至 v0.3（D1 积分制、D2 中立基地、D3 上限 8 等）
- 2026-10-19 M1 实现（细节见 activeContext「M1 实现要点」）；期间修复 `drainEvents` 返回被清空数组的 bug
- 2026-10-19 M1 收尾与发布准备：文档一致性修订、README.md、MIT LICENSE、git 仓库初始化与首次提交（中性提交身份）
- 2026-10-19 发布到 GitHub：公开仓库 https://github.com/qonies/TanKing （账号 qonies），main 已推送（c2c1acd）；仓库级 gh 凭据助手已配置
- 2026-10-19 审查修复：默认 8 分钟限时接入、击杀记账按 id 查找、子弹互消标记式（修三弹漏判）、findSpawn 兜底防重叠、文档状态行同步；新增 3 个回归测试（32/32 全绿）
- 2026-10-19 M2 联机打通：WebSocket 服务器、房间状态机、快照同步与插值、AI 补位；L2 集成 9 例（41/41）；双人开局冒烟通过
- 2026-10-19 M3 内容完整：四级坦克（快弹/双发/破钢/D6 降级）、六种道具、中立基地、Web Audio 音效、6 张内置地图（scripts/gen-maps.cjs）；tests/m3.test.ts 15 例（56/56）；单人开局冒烟通过
- 2026-10-20 M4 多人体验：审查修复 4 项（对局中幽灵玩家/Bot 下标寻址/地图校验/道具冷却）+ 8 坦克房间与房主配置（FR-N3/D3）、AI 三档难度（hard 抢道具/护家，FR-A3）、聊天（D4）、键位自定义（FR-S1）、断线托管与重连（FR-N4）、消息限流（NFR-6）；tests/m4.test.ts 13 例（69/69）；期间发现并修复 bfsDir 目标格越界导致 BFS 回溯死循环的严重 bug

## 已知问题 / 风险
- 原版手感逐帧像素比对（需 FC 模拟器）未执行，M5 已将 ⚠️ 近似项作为明确设计决策定稿（参数对照表 M5 结论），列为发布后可选增强。
- E2E Playwright 未落地（浏览器下载受环境限制），以 HTTP/WS 冒烟 + 集成测试替代；后续可补。
- L4 手工联机清单（真机局域网 ≥3 设备、延迟录屏测量、多浏览器兼容）未执行，**为正式发布验收的最后一项**；NFR-2 延迟已引入本机坦克航位推算（理论预算 35~50ms），实测待 L4 录屏。
- 素材为占位色块，正式像素素材（sprite sheet）待制作。
- 断线托管为「同名重连」尽力而为方案：无账号/令牌机制，同名即接管（PRD FR-N4 允许；同名成员互冒风险已知）。二轮审查已加客户端自动重连（≤3 次）与昵称会话持久化，刷新页面后可回填同名接管。
- 房间为单实例（单房间），多房间不在本期范围。
- 客户端模块 renderer/audio/input/net/main 无单元测试（coverage 仅含 shared/server；client/interp.ts 已有 5 例单测），由 L2 集成 + 冒烟覆盖，E2E 落地后可补 DOM 断言。
