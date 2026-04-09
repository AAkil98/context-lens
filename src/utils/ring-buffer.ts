/**
 * Bounded ring buffer — oldest items evicted on overflow.
 */

export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private readonly capacity: number;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    this.items[index] = item;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.items[(this.head + index) % this.capacity];
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.items[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
