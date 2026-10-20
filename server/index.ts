import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { TICK_RATE } from '../shared/constants';
import type { S2CMessage } from '../shared/protocol';
import { MAPS } from '../shared/maps';
import { startTickLoop } from './gameLoop';
import { Room, type Conn } from './room';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---- HTTP：托管前端构建产物（NFR-4：一条命令、一个端口） ----
const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let file = join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ---- 游戏房间（内置地图轮换） ----
const room = new Room(MAPS);

// ---- WebSocket：与 HTTP 共享端口，路径 /ws ----
const wss = new WebSocketServer({ server, path: '/ws' });
let nextConnId = 1;

wss.on('connection', (socket: WebSocket) => {
  const conn: Conn = {
    id: nextConnId++,
    send: (msg: S2CMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TanKing] 服务器已启动: http://<本机IP>:${PORT}（本机调试: http://localhost:${PORT}）`);
});

process.on('SIGINT', () => {
  stopLoop();
  wss.close();
  server.close();
  process.exit(0);
});