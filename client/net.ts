import type { C2SMessage, S2CMessage } from '../shared/protocol';

/** 连接管理（技术路线 §3 client/net.ts）；断线重连在 M4（FR-N4） */
export class NetClient {
  private ws: WebSocket | null = null;
  onOpen: (() => void) | null = null;
  onMessage: ((msg: S2CMessage) => void) | null = null;
  onClose: (() => void) | null = null;

  connect(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this.onOpen?.(); };
    ws.onmessage = (e: MessageEvent) => {
      try {
        this.onMessage?.(JSON.parse(String(e.data)) as S2CMessage);
      } catch {
        // 坏包忽略
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) { this.ws = null; this.onClose?.(); }
    };
    ws.onerror = () => { /* onclose 会随后触发 */ };
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: C2SMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}