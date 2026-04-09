/**
 * Generic LRU cache — doubly-linked list + Map for O(1) get/set/delete.
 */

interface Node<K, V> {
  key: K;
  value: V;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

export class LruCache<K, V> {
  private readonly maxSize: number;
  private readonly map = new Map<K, Node<K, V>>();
  private head: Node<K, V> | null = null;
  private tail: Node<K, V> | null = null;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (node === undefined) return undefined;
    this.moveToHead(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.moveToHead(existing);
      return;
    }

    const node: Node<K, V> = { key, value, prev: null, next: null };
    this.map.set(key, node);
    this.addToHead(node);

    if (this.map.size > this.maxSize) {
      this.removeTail();
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  *entries(): IterableIterator<[K, V]> {
    let node = this.head;
    while (node !== null) {
      yield [node.key, node.value];
      node = node.next;
    }
  }

  private addToHead(node: Node<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) {
      this.head.prev = node;
    }
    this.head = node;
    if (this.tail === null) {
      this.tail = node;
    }
  }

  private removeNode(node: Node<K, V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: Node<K, V>): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  private removeTail(): void {
    if (this.tail === null) return;
    const removed = this.tail;
    this.removeNode(removed);
    this.map.delete(removed.key);
  }
}
