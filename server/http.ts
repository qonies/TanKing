import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute, extname, join, relative } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 静态文件服务（NFR-4：一条命令、一个端口托管前端构建产物）。
 * 安全与健壮性：
 * - URL 解析全部包在 try/catch 中，畸形 URL（如 /%E0%A4%A）返回 400，进程不崩溃；
 * - 路径逃逸用 path.relative 严格判断（startsWith 前缀可被 dist-evil 等目录绕过）；
 * - 带扩展名的资源请求（js/css/png…）缺失或逃逸一律 404，不回落 SPA；
 * - 文件读取使用 fs/promises 异步 API，不阻塞事件循环。
 */
export function createHttpServer(distDir: string) {
  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (urlPath.includes('\0')) throw new Error('invalid path');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const notFound = (): void => {
      res.writeHead(404);
      res.end('Not Found');
    };
    const sendFile = async (file: string): Promise<boolean> => {
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(data);
        return true;
      } catch {
        return false;
      }
    };

    const requested = join(distDir, urlPath === '/' ? 'index.html' : urlPath);
    const rel = relative(distDir, requested);
    const escaped = rel.startsWith('..') || isAbsolute(rel);
    const hasExt = extname(urlPath) !== '';

    // 路径逃逸 / 资源类请求：不回落 SPA，直接 404（缺失资源返回 index.html 会引发 MIME 混淆）
    if (escaped) {
      notFound();
      return;
    }
    if (hasExt) {
      if (!(await sendFile(requested))) notFound();
      return;
    }

    // 无扩展名路径：文件 → 目录下 index.html → SPA fallback（index.html）
    if (await sendFile(requested)) return;
    if (await sendFile(join(requested, 'index.html'))) return;
    if (!(await sendFile(join(distDir, 'index.html')))) notFound();
  }
}