import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, extname, join, relative } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 静态文件服务（NFR-4：一条命令、一个端口托管前端构建产物）。
 * 安全修复：
 * - URL 解析/文件读取全部包在 try/catch 中，畸形 URL（如 /%E0%A4%A）返回 400，进程不崩溃；
 * - 路径逃逸用 path.relative 严格判断（startsWith 前缀可被 dist-evil 等目录绕过），逃逸路径回落 SPA index.html。
 */
export function createHttpServer(distDir: string) {
  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    let file: string;
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (urlPath.includes('\0')) throw new Error('invalid path');
      file = join(distDir, urlPath === '/' ? 'index.html' : urlPath);
      const rel = relative(distDir, file);
      const escaped = rel.startsWith('..') || isAbsolute(rel);
      if (escaped || !existsSync(file) || statSync(file).isDirectory()) {
        file = join(distDir, 'index.html'); // SPA fallback
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
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
}