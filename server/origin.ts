/**
 * WebSocket 握手 Origin 校验（NFR-6）：拒绝来自其他站点的跨站 WebSocket（CSWSH）。
 * 规则：
 * 1. 无 Origin（非浏览器客户端/测试工具）放行；
 * 2. 同源（Origin 的 host 与请求 Host 一致，生产模式与 Vite 代理均命中）放行；
 * 3. 本机调试：Origin 为回环地址时，要求请求 Host 也是回环 —— 防止本机其他端口
 *    页面（http://localhost:8080 等）跨站连接局域网游戏服务器。
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // 非浏览器客户端（测试/工具）允许
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true; // 同源（生产模式 / Vite 代理）
    if (!LOOPBACK_HOSTS.has(o.hostname)) return false;
    if (!host) return true;
    const hostName = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1)
      : (host.split(':')[0] ?? host);
    return LOOPBACK_HOSTS.has(hostName);
  } catch {
    return false;
  }
}