/**
 * Defensive copy helpers for public API boundaries.
 * Handles: plain objects, arrays, Date, Map, Set, null, primitives.
 * Does NOT handle: functions, class instances with methods, circular references.
 */

export function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (value instanceof Map) {
    const copy = new Map();
    for (const [k, v] of value) {
      copy.set(deepCopy(k), deepCopy(v));
    }
    return copy as T;
  }

  if (value instanceof Set) {
    const copy = new Set();
    for (const v of value) {
      copy.add(deepCopy(v));
    }
    return copy as T;
  }

  if (Array.isArray(value)) {
    return value.map(deepCopy) as T;
  }

  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = deepCopy((value as Record<string, unknown>)[key]);
  }
  return copy as T;
}
