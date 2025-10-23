export class AsyncQueue {
  private lastPromise: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lastPromise.then(() => fn());
    this.lastPromise = run.finally(() => {});
    return run;
  }
}
