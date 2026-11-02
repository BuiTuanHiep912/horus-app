import { reconnectDelayMs } from './reconnectDelay';

describe('reconnectDelayMs', () => {
  it('doubles from 1s and caps at 15s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
  });

  it('treats a negative attempt as the first one', () => {
    expect(reconnectDelayMs(-3)).toBe(1000);
  });
});
