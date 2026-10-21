/**
 * 固定步长 tick 循环（技术路线 §5）：时间累积器吸收抖动，追帧上限防雪崩。
 * 韧性（NFR-5）：onTick 抛异常时跳过该帧继续运行，连续异常过多才停止（防日志洪泛）。
 * 返回停止函数。
 */
const MAX_CONSECUTIVE_ERRORS = 60; // 约 1 秒的连续异常后放弃，避免 60 次/秒的错误日志

export function startTickLoop(tickMs: number, onTick: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Date.now();
  let acc = 0;
  let stopped = false;
  let errorStreak = 0;

  const loop = (): void => {
    if (stopped) return;
    try {
      const now = Date.now();
      acc += now - last;
      last = now;
      if (acc > 250) acc = 250; // 切后台/卡顿后不追帧
      while (acc >= tickMs) {
        acc -= tickMs;
        onTick();
      }
      errorStreak = 0;
    } catch (err) {
      errorStreak++;
      console.error('[TanKing] tick 异常（已跳过，循环继续）:', err);
      if (errorStreak >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[TanKing] 连续异常过多，tick 循环已停止');
        stopped = true;
        return;
      }
    } finally {
      if (!stopped) timer = setTimeout(loop, 1); // setTimeout 不精确，用 1ms 忙等 + 累积器
    }
  };
  timer = setTimeout(loop, tickMs);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}