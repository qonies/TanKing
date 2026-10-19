/**
 * 固定步长 tick 循环（技术路线 §5）：时间累积器吸收抖动，追帧上限防雪崩。
 * 返回停止函数。
 */
export function startTickLoop(tickMs: number, onTick: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Date.now();
  let acc = 0;
  let stopped = false;

  const loop = (): void => {
    if (stopped) return;
    const now = Date.now();
    acc += now - last;
    last = now;
    if (acc > 250) acc = 250; // 切后台/卡顿后不追帧
    while (acc >= tickMs) {
      acc -= tickMs;
      onTick();
    }
    timer = setTimeout(loop, 1); // setTimeout 不精确，用 1ms 忙等 + 累积器
  };
  timer = setTimeout(loop, tickMs);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}