export class QueueFailure extends Error {
  constructor(readonly code: 'queue_full' | 'queue_start_timeout') { super(code); }
}
type Job<T> = { key: string; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; started: boolean };
export class RefreshQueue {
  private readonly pending: Job<unknown>[] = [];
  private readonly keys = new Set<string>();
  private running = 0;
  constructor(private readonly concurrency = 2, private readonly maxJobs = 10, private readonly startDeadlineMs = 10_000) {}
  get active(): number { return this.running; }
  get queued(): number { return this.pending.length; }
  has(key: string): boolean { return this.keys.has(key); }
  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.keys.has(key)) return Promise.reject(new Error('job_already_queued'));
    if (this.keys.size >= this.maxJobs) return Promise.reject(new QueueFailure('queue_full'));
    this.keys.add(key);
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { key, run, resolve, reject, started: false, timer: setTimeout(() => {
        if (job.started) return;
        const index = this.pending.indexOf(job as Job<unknown>);
        if (index >= 0) this.pending.splice(index, 1);
        this.keys.delete(key);
        reject(new QueueFailure('queue_start_timeout'));
      }, this.startDeadlineMs) };
      this.pending.push(job as Job<unknown>);
      this.pump();
    });
  }
  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      if (!this.keys.has(job.key)) continue;
      job.started = true;
      clearTimeout(job.timer);
      this.running += 1;
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.running -= 1;
        this.keys.delete(job.key);
        this.pump();
      });
    }
  }
}
