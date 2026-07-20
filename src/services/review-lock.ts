export interface ReviewLock {
  runExclusive<T>(reviewId: string, operation: () => Promise<T>): Promise<T>;
}

export class InMemoryReviewLock implements ReviewLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(reviewId) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => slot);
    this.tails.set(reviewId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(reviewId) === tail) this.tails.delete(reviewId);
    }
  }
}
