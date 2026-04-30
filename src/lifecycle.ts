/**
 * Internal lifecycle infrastructure for cl-spec-015.
 *
 * Owns the IntegrationRegistry. Imports only types/errors/events — does not
 * import index.ts, fleet.ts, or otel.ts (the registry receives anonymous
 * callbacks; it knows nothing about the integrations that register them).
 *
 * @see cl-spec-015 §3, §4, §6
 * @internal
 */

import type { IntegrationTeardown, IntegrationHandle } from './types.js';

interface IntegrationEntry<T> {
  readonly callback: IntegrationTeardown<T>;
  detached: boolean;
}

/**
 * Per-instance registry of integration teardown callbacks. Single-threaded
 * and synchronous; owned by exactly one ContextLens instance and not shared.
 *
 * Detach is flag-based, not splice-based — invokeAll skips entries whose flag
 * is set. This keeps detach O(1) and makes the registry safe against
 * detach-during-iteration if a teardown callback unhooks a sibling
 * integration before the sibling's callback runs.
 *
 * @see cl-spec-015 §4.1, §6.2
 */
export class IntegrationRegistry<T = unknown> {
  private readonly entries: IntegrationEntry<T>[] = [];

  attach(callback: IntegrationTeardown<T>): IntegrationHandle {
    const entry: IntegrationEntry<T> = { callback, detached: false };
    this.entries.push(entry);
    return {
      detach: () => { entry.detached = true; },
    };
  }

  invokeAll(instance: T, errorLog: unknown[]): void {
    for (const entry of this.entries) {
      if (entry.detached) continue;
      try {
        entry.callback(instance);
      } catch (error) {
        errorLog.push(error);
      }
    }
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Number of attached, non-detached integrations. */
  get size(): number {
    let count = 0;
    for (const entry of this.entries) {
      if (!entry.detached) count++;
    }
    return count;
  }
}
