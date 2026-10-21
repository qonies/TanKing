# 技术上下文（Tech Context）

> 详细技术路线与选型论证见 `docs/02-技术路线.md`，此处为速查摘要。

## 技术栈（已评审确认）
| 层 | 选型 | 说明 |
|---|---|---|
| 前端框架 | TypeScript + Vite + 原生 HTML5 Canvas | 游戏渲染无需 UI 框架；菜单/HUD 用 Canvas 或轻量 DOM |
| 渲染 | Canvas 2D，`imageSmoothingEnabled=false` | 像素风渲染，逻辑分辨率 416×416（13×13 大格）整数倍缩放 |
| 音频 | Web Audio API | 音效合成或 CC0 采样，无需额外音频库 |
| 后端 | Node.js 20+ + TypeScript | 同一语言栈，游戏逻辑可前后端共享 |
| 通信 | WebSocket（`ws` 库）+ 自定义二进制/JSON 协议 | 局域网低延迟，服务器权威模型 |
| 房间服务 | Node 进程同时托管 HTTP 静态文件 + WebSocket | 一个命令启动，客户端访问 `http://<host-ip>:3000` |
| 单元测试 | Vitest | 游戏逻辑纯函数化，Node 环境 headless 运行；覆盖率 @vitest/coverage-v8（`npm run test:coverage`，阈值行 85%/函数 80%） |
| 性能验证 | scripts/perf.ts（`npm run perf`） | BattleSim tick 耗时 + 快照体积（M5 实测：avg 0.002ms / 1.42KB） |
| E2E 测试 | Playwright | 多浏览器页面实例模拟多人联机（**发布后可选增强，M5 未落地**） |

## 开发环境（Windows）
- Node.js ≥ 20, npm
- `npm run dev`：concurrently 并行启动 Vite(5173，`server.host: true` 监听 0.0.0.0 供局域网访问，代理 /ws→3000) + tsx watch 游戏服务器(3000)
- `npm run build` + `npm start`：生产模式，单端口 3000 托管（服务器读 `dist/`）；**局域网联机务必用生产模式**（dev 的 3000 端口只托管 dist 静态产物）；`prestart` 会检查 dist 产物存在性（scripts/check-dist.cjs）
- 浏览器目标：Chrome / Edge / Firefox 最新两个大版本

## 技术约束
1. **局域网限定**：不做 NAT 穿透、不做公网匹配；主机需在防火墙放行端口。
2. **服务器权威**：所有碰撞、伤害、道具、计分判定在服务器；客户端只做输入上报 + 渲染插值（防作弊且逻辑单点）。
3. **游戏逻辑双端共享**：实体定义、地图格式、常量表放在 `shared/` 目录，前端渲染与服务器模拟引用同一份代码。
4. **素材自制**：像素图用 Aseprite 等工具自制或 CC0 素材，禁止提取原版 ROM 资源。
