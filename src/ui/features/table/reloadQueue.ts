/** Serializes reloads, merging a burst into the newest captured request. */
export class ReloadQueue<Request> {
  private pending?: Request;
  private active?: Request;
  private running?: Promise<void>;
  private revision = 0;

  constructor(
    private readonly merge: (current: Request, next: Request) => Request,
    private readonly execute: (
      request: Request,
      isCurrent: () => boolean,
    ) => Promise<void>,
  ) {}

  enqueue(request: Request): Promise<void> {
    this.revision += 1;
    const previous = this.pending || this.active;
    this.pending = previous ? this.merge(previous, request) : request;
    if (!this.running) {
      // Defer the drain one microtask so synchronous notifications form one batch.
      const running = Promise.resolve().then(() => this.drain());
      this.running = running;
      void running
        .finally(() => {
          if (this.running === running) this.running = undefined;
        })
        .catch(() => undefined);
    }
    return this.running;
  }

  invalidate(): void {
    this.revision += 1;
    this.pending = undefined;
  }

  private async drain(): Promise<void> {
    let failure: unknown;
    while (this.pending) {
      const request = this.pending;
      const revision = this.revision;
      this.active = request;
      this.pending = undefined;
      try {
        await this.execute(request, () => revision === this.revision);
        failure = undefined;
      } catch (error) {
        failure = error;
      } finally {
        this.active = undefined;
      }
    }
    if (failure !== undefined) throw failure;
  }
}

/** Preserve references for unchanged rows, including an entirely unchanged map. */
export function reconcileRows<Key, Value>(
  current: Map<Key, Value>,
  next: Map<Key, Value>,
  equal: (left: Value, right: Value) => boolean,
): Map<Key, Value> {
  let unchanged = current.size === next.size;
  const previousKeys = current.keys();
  for (const [key, value] of next) {
    const previous = current.get(key);
    if (current.has(key) && equal(previous!, value)) next.set(key, previous!);
    else unchanged = false;
    if (previousKeys.next().value !== key) unchanged = false;
  }
  return unchanged ? current : next;
}
