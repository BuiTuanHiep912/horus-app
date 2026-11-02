/** Backoff nối lại preview: 1s, 2s, 4s, 8s, rồi giữ 15s. `attempt` đếm từ 0, về 0 khi live lại. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 15000);
}
