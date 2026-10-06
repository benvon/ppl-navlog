import { describe, expect, it, vi } from 'vitest';
import { RefreshQueue } from './queue';

describe('RefreshQueue', () => {
  it('bounds active work, queued unique jobs, and deadlines', async () => {
    vi.useFakeTimers();
    const queue = new RefreshQueue(2, 10, 10_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue('a', () => gate);
    const second = queue.enqueue('b', () => gate);
    const queued = Array.from({ length: 8 }, (_, index) => queue.enqueue(`q${index}`, async () => index));
    const queuedOutcomes = Promise.allSettled(queued);
    expect(queue.active).toBe(2);
    expect(queue.queued).toBe(8);
    expect(queue.active + queue.queued).toBe(10);
    await expect(queue.enqueue('overflow', async () => 1)).rejects.toThrow('queue_full');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await queuedOutcomes).every((result) => result.status === 'rejected' && result.reason.message === 'queue_start_timeout')).toBe(true);
    release();
    await Promise.all([first, second]);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });
});
