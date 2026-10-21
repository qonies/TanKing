import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { TICK_RATE } from '../shared/constants';
import type { S2CMessage } from '../shared/protocol';
import { MAPS } from '../shared/maps';
import { startTickLoop } from './gameLoop';
import { createHttpServer } from './http';
import { originAllowed } from './origin';
import { Room, type Conn } from './room';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// ---- HTTP：托管前端构建产物（NFR-4：一条命令、一个端口；畸形 URL 返回 400 不崩溃） ----
const server = createHttpServer(DIST);

// ---- 游戏房间（内置地图轮换；D3 默认 6 坦克，房主可配置 2~8） ----
const room = new Room(MAPS, { maxTanks: 6 });

// ---- WebSocket：与 HTTP 共享端口，路径 /ws ----
const MAX_CONNECTIONS = 32; // 局域网游戏足够，防止连接洪水
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4 * 1024, // 消息均为小 JSON（input/chat/config），超限直接断开
  verifyClient: (info, callback) => {
    callback(originAllowed(info.req.headers.origin, info.req.headers.host));
  },
});
let nextConnId = 1;

wss.on('connection', (socket: WebSocket) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    socket.close();
    return;
  }
  const conn: Conn = {
    id: nextConnId++,
    send: (msg: S2CMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    sendRaw: (json: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(json);
    },
    close: () => socket.close(),
  };
  room.addConnection(conn);
  socket.on('message', (data) => {
    try {
      room.handleMessage(conn.id, JSON.parse(String(data)));
    } catch {
      // 坏 JSON / 非法消息：忽略，服务器不崩溃（完整限流在后续里程碑，NFR-6）
    }
  });
  socket.on('close', () => room.removeConnection(conn.id));
  socket.on('error', () => { /* close 会随后触发 */ });
});

const stopLoop = startTickLoop(1000 / TICK_RATE, () => room.step());

// 局域网游戏服务器韧性：兜底防止未捕获异常打崩进程（tick 循环自身已在 gameLoop 内容错）
process.on('uncaughtException', (err) => {
  console.error('[TanKing] 未捕获异常（已忽略，服务器继续运行）:', err);
});

// 端口占用等致命错误：明确退出，避免进程假活（无 error 监听时 EADDRINUSE 会被 uncaughtException 吞掉）
server.on('error', (err) => {
  console.error('[TanKing] 服务器错误，即将退出:', err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TanKing] 服务器已启动: http://<本机IP>:${PORT}（本机调试: http://localhost:${PORT}）`);
});

process.on('SIGINT', () => {
  stopLoop();
  wss.close();
  server.close();
  process.exit(0);
});