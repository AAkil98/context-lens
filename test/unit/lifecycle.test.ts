import { describe, it, expect, vi } from 'vitest';
import {
  IntegrationRegistry,
  READ_ONLY_METHODS,
  guardDispose,
  runTeardown,
  type TeardownContext,
} from '../../src/lifecycle.js';
import { DisposedError } from '../../src/errors.js';
import { EventEmitter, type ContextLensEventMap, type StateDisposedEvent } from '../../src/events.js';
import type { IntegrationHandle, LifecycleState } from '../../src/types.js';

interface FakeInstance {
  tag: string;
}

const fake: FakeInstance = { tag: 'fake' };

// ─── IntegrationRegistry (cl-spec-015 §4.1, §6.2) ─────────────────

describe('IntegrationRegistry.attach', () => {
  it('returns a handle with a detach() method', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const handle: IntegrationHandle = reg.attach(() => {});
    expect(typeof handle.detach).toBe('function');
  });

  it('appends multiple callbacks; size reflects the live count', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    reg.attach(() => {});
    reg.attach(() => {});
    reg.attach(() => {});
    expect(reg.size).toBe(3);
  });
});

describe('IntegrationRegistry.invokeAll', () => {
  it('dispatches callbacks in registration order with the supplied instance', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const seen: string[] = [];

    reg.attach((i) => seen.push(`a:${i.tag}`));
    reg.attach((i) => seen.push(`b:${i.tag}`));
    reg.attach((i) => seen.push(`c:${i.tag}`));

    const errorLog: unknown[] = [];
    reg.invokeAll(fake, errorLog);

    expect(seen).toEqual(['a:fake', 'b:fake', 'c:fake']);
    expect(errorLog).toEqual([]);
  });

  it('catches throws and pushes them onto errorLog in caught-order', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const e1 = new Error('boom-1');
    const e3 = new Error('boom-3');

    reg.attach(() => { throw e1; });
    reg.attach(() => { /* ok */ });
    reg.attach(() => { throw e3; });

    const errorLog: unknown[] = [];
    reg.invokeAll(fake, errorLog);

    expect(errorLog).toHaveLength(2);
    expect(errorLog[0]).toBe(e1);
    expect(errorLog[1]).toBe(e3);
  });

  it('does not abort iteration on a throwing callback', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    let firstRan = false;
    let secondRan = false;
    let thirdRan = false;

    reg.attach(() => { firstRan = true; throw new Error('first'); });
    reg.attach(() => { secondRan = true; });
    reg.attach(() => { thirdRan = true; });

    reg.invokeAll(fake, []);

    expect(firstRan).toBe(true);
    expect(secondRan).toBe(true);
    expect(thirdRan).toBe(true);
  });

  it('skips entries whose handle was detached before invokeAll', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const seen: string[] = [];

    reg.attach(() => seen.push('a'));
    const h2 = reg.attach(() => seen.push('b'));
    reg.attach(() => seen.push('c'));

    h2.detach();
    reg.invokeAll(fake, []);

    expect(seen).toEqual(['a', 'c']);
  });

  it('appends to a non-empty errorLog without disturbing prior entries', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    reg.attach(() => { throw new Error('new'); });

    const errorLog: unknown[] = ['preexisting'];
    reg.invokeAll(fake, errorLog);

    expect(errorLog).toHaveLength(2);
    expect(errorLog[0]).toBe('preexisting');
    expect(errorLog[1]).toBeInstanceOf(Error);
  });

  it('is safe when a callback detaches a not-yet-fired sibling handle mid-iteration', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const seen: string[] = [];

    reg.attach(() => {
      seen.push('a');
      h2.detach();   // detach the next entry before it runs
    });
    const h2 = reg.attach(() => seen.push('b'));
    reg.attach(() => seen.push('c'));

    reg.invokeAll(fake, []);

    expect(seen).toEqual(['a', 'c']);
  });
});

describe('IntegrationRegistry.detach', () => {
  it('is idempotent — repeated detach calls do not throw', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const handle = reg.attach(() => {});
    expect(() => {
      handle.detach();
      handle.detach();
      handle.detach();
    }).not.toThrow();
  });

  it('detaching one handle does not affect others', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const seen: string[] = [];

    const h1 = reg.attach(() => seen.push('a'));
    reg.attach(() => seen.push('b'));

    h1.detach();
    reg.invokeAll(fake, []);

    expect(seen).toEqual(['b']);
  });

  it('size decrements when a handle is detached', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const h1 = reg.attach(() => {});
    reg.attach(() => {});
    expect(reg.size).toBe(2);

    h1.detach();
    expect(reg.size).toBe(1);
  });
});

describe('IntegrationRegistry.clear', () => {
  it('drops all entries; size returns 0', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    reg.attach(() => {});
    reg.attach(() => {});
    reg.clear();
    expect(reg.size).toBe(0);
  });

  it('subsequent invokeAll dispatches to nothing', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    let ran = false;
    reg.attach(() => { ran = true; });
    reg.clear();

    reg.invokeAll(fake, []);
    expect(ran).toBe(false);
  });

  it('detaching a handle after clear is a no-op (does not throw)', () => {
    const reg = new IntegrationRegistry<FakeInstance>();
    const handle = reg.attach(() => {});
    reg.clear();
    expect(() => handle.detach()).not.toThrow();
  });
});

// ─── READ_ONLY_METHODS classification (impl-spec I-06 §4.1.3) ───

describe('READ_ONLY_METHODS', () => {
  it('contains the 12 unchanged names from cl-spec-015 §3.4', () => {
    const required = [
      'getCapacity', 'getSegment', 'listSegments', 'getSegmentCount',
      'listGroups', 'getGroup',
      'getTask', 'getTaskState',
      'getDiagnostics', 'assess', 'planEviction', 'snapshot',
    ];
    for (const name of required) {
      expect(READ_ONLY_METHODS.has(name)).toBe(true);
    }
  });

  it('reconciles cl-spec-015 §3.4 `getEvictionHistory` to actual `getEvictedSegments`', () => {
    expect(READ_ONLY_METHODS.has('getEvictedSegments')).toBe(true);
    // The spec name itself is NOT in the set — the audit treats them as the same logical method.
    expect(READ_ONLY_METHODS.has('getEvictionHistory')).toBe(false);
  });

  it('contains the 7 audit-added read-only methods', () => {
    const audit = [
      'getTokenizerInfo', 'getEmbeddingProviderInfo',
      'getBaseline', 'getConstructionTimestamp', 'getConfig',
      'getPerformance', 'getDetection',
    ];
    for (const name of audit) {
      expect(READ_ONLY_METHODS.has(name)).toBe(true);
    }
  });

  it('does not contain known mutating methods', () => {
    const mutating = [
      'seed', 'add', 'update', 'replace', 'compact', 'split', 'evict', 'restore',
      'createGroup', 'dissolveGroup',
      'setTask', 'clearTask',
      'setTokenizer', 'setEmbeddingProvider', 'setCapacity',
      'registerPattern',
      'on', 'attachIntegration',
    ];
    for (const name of mutating) {
      expect(READ_ONLY_METHODS.has(name)).toBe(false);
    }
  });

  it('does not contain the four lifecycle exemptions', () => {
    // These bypass the guard entirely; the contract is that the guard never sees them.
    const exempt = ['dispose', 'isDisposed', 'isDisposing', 'instanceId'];
    for (const name of exempt) {
      expect(READ_ONLY_METHODS.has(name)).toBe(false);
    }
  });

  it('has size 20 (12 unchanged + 1 reconciled + 7 audit-added)', () => {
    expect(READ_ONLY_METHODS.size).toBe(20);
  });
});

// ─── guardDispose (impl-spec I-06 §4.1.4) ──────────────────────

describe('guardDispose', () => {
  it('returns silently when state is "live", regardless of method name', () => {
    expect(() => guardDispose('live', 'add', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('live', 'getCapacity', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('live', 'unknownMethodNotInSet', 'cl-1-abc123')).not.toThrow();
  });

  it('throws DisposedError for any method when state is "disposed"', () => {
    expect(() => guardDispose('disposed', 'add', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposed', 'getCapacity', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposed', 'snapshot', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposed', 'assess', 'cl-1-abc123')).toThrow(DisposedError);
  });

  it('throws DisposedError for mutating methods when state is "disposing"', () => {
    expect(() => guardDispose('disposing', 'add', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposing', 'on', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposing', 'evict', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposing', 'setCapacity', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposing', 'attachIntegration', 'cl-1-abc123')).toThrow(DisposedError);
  });

  it('returns silently for read-only methods when state is "disposing"', () => {
    expect(() => guardDispose('disposing', 'getCapacity', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('disposing', 'snapshot', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('disposing', 'assess', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('disposing', 'getDiagnostics', 'cl-1-abc123')).not.toThrow();
    expect(() => guardDispose('disposing', 'planEviction', 'cl-1-abc123')).not.toThrow();
  });

  it('thrown DisposedError carries instanceId and attemptedMethod', () => {
    try {
      guardDispose('disposed', 'evict', 'cl-99-zzz000');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DisposedError);
      const err = e as DisposedError;
      expect(err.instanceId).toBe('cl-99-zzz000');
      expect(err.attemptedMethod).toBe('evict');
    }
  });

  it('disposed-state throw produces a "is disposed" message', () => {
    try {
      guardDispose('disposed', 'add', 'cl-1-abc123');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe(
        'ContextLens instance cl-1-abc123 is disposed; cannot call add()',
      );
    }
  });

  it('disposing-state throw produces a "is disposing" message', () => {
    try {
      guardDispose('disposing', 'add', 'cl-1-abc123');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe(
        'ContextLens instance cl-1-abc123 is disposing; cannot call add()',
      );
    }
  });

  it('treats unknown method names as mutating during "disposing"', () => {
    // Defensive: any name not in READ_ONLY_METHODS, including typos or future
    // method names, must throw during disposal. The classification is closed —
    // explicit opt-in only.
    expect(() => guardDispose('disposing', 'futureMethod', 'cl-1-abc123')).toThrow(DisposedError);
    expect(() => guardDispose('disposing', '', 'cl-1-abc123')).toThrow(DisposedError);
  });
});

// ─── runTeardown orchestrator (impl-spec I-06 §4.1.5) ──────────────

interface TeardownProbe {
  emitter: EventEmitter<ContextLensEventMap>;
  registry: IntegrationRegistry<FakeInstance>;
  state: { current: LifecycleState };
  sequence: string[];
  payloadFactoryCalls: number;
  ctx: TeardownContext<FakeInstance>;
}

function makeTeardownProbe(): TeardownProbe {
  const emitter = new EventEmitter<ContextLensEventMap>();
  const registry = new IntegrationRegistry<FakeInstance>();
  const state: { current: LifecycleState } = { current: 'live' };
  const sequence: string[] = [];
  let payloadFactoryCalls = 0;

  const ctx: TeardownContext<FakeInstance> = {
    setState: (s) => {
      sequence.push(`setState:${s}`);
      state.current = s;
    },
    emitter,
    integrations: registry,
    clearResources: () => {
      sequence.push('clearResources');
    },
    instance: { tag: 'fake' },
    payloadFactory: () => {
      payloadFactoryCalls++;
      return Object.freeze({
        type: 'stateDisposed' as const,
        instanceId: 'cl-1-abc123',
        timestamp: 1234567890,
      });
    },
  };

  return { emitter, registry, state, sequence, get payloadFactoryCalls() { return payloadFactoryCalls; }, ctx } as TeardownProbe;
}

describe('runTeardown — step ordering', () => {
  it('runs the six steps in fixed order', () => {
    const probe = makeTeardownProbe();
    probe.emitter.on('stateDisposed', () => probe.sequence.push('handler'));
    probe.registry.attach(() => probe.sequence.push('integration'));

    runTeardown(probe.ctx);

    expect(probe.sequence).toEqual([
      'setState:disposing',  // Step 1
      'handler',             // Step 2 — emitCollect dispatched stateDisposed
      'integration',         // Step 3 — invokeAll dispatched the integration callback
      'clearResources',      // Step 4
      'setState:disposed',   // Step 6 (step 5 is silent — verified via post-conditions)
    ]);
  });

  it('final lifecycle state is "disposed" after teardown returns', () => {
    const probe = makeTeardownProbe();
    runTeardown(probe.ctx);
    expect(probe.state.current).toBe('disposed');
  });

  it('all four library-internal steps still run when callbacks throw', () => {
    const probe = makeTeardownProbe();
    probe.emitter.on('stateDisposed', () => { throw new Error('handler-boom'); });
    probe.registry.attach(() => { throw new Error('integration-boom'); });

    runTeardown(probe.ctx);

    expect(probe.sequence).toContain('clearResources');
    expect(probe.state.current).toBe('disposed');
  });
});

describe('runTeardown — step 2 (stateDisposed dispatch)', () => {
  it('invokes payloadFactory exactly once', () => {
    const probe = makeTeardownProbe();
    probe.emitter.on('stateDisposed', () => {});
    runTeardown(probe.ctx);
    expect(probe.payloadFactoryCalls).toBe(1);
  });

  it('delivers the frozen payload to handlers', () => {
    const probe = makeTeardownProbe();
    let received: StateDisposedEvent | null = null;
    probe.emitter.on('stateDisposed', (p) => { received = p; });

    runTeardown(probe.ctx);

    expect(received).not.toBeNull();
    expect(received!.type).toBe('stateDisposed');
    expect(received!.instanceId).toBe('cl-1-abc123');
    expect(received!.timestamp).toBe(1234567890);
    expect(Object.isFrozen(received!)).toBe(true);
  });

  it('captures handler errors and tags them with origin="handler"', () => {
    const probe = makeTeardownProbe();
    const e1 = new Error('h1');
    const e2 = new Error('h2');
    probe.emitter.on('stateDisposed', () => { throw e1; });
    probe.emitter.on('stateDisposed', () => { /* ok */ });
    probe.emitter.on('stateDisposed', () => { throw e2; });

    const errorLog = runTeardown(probe.ctx);

    expect(errorLog).toHaveLength(2);
    expect((errorLog[0] as { origin: string; index: number; cause: unknown }).origin).toBe('handler');
    expect((errorLog[0] as { index: number }).index).toBe(0);
    expect((errorLog[0] as { cause: unknown }).cause).toBe(e1);
    expect((errorLog[1] as { origin: string; index: number; cause: unknown }).origin).toBe('handler');
    expect((errorLog[1] as { index: number }).index).toBe(1);
    expect((errorLog[1] as { cause: unknown }).cause).toBe(e2);
  });
});

describe('runTeardown — step 3 (integration teardown)', () => {
  it('invokes integration callbacks with the instance reference', () => {
    const probe = makeTeardownProbe();
    let receivedInstance: FakeInstance | null = null;
    probe.registry.attach((inst) => { receivedInstance = inst; });

    runTeardown(probe.ctx);

    expect(receivedInstance).toBe(probe.ctx.instance);
  });

  it('captures integration errors and tags them with origin="integration"', () => {
    const probe = makeTeardownProbe();
    const e1 = new Error('i1');
    const e2 = new Error('i2');
    probe.registry.attach(() => { throw e1; });
    probe.registry.attach(() => { /* ok */ });
    probe.registry.attach(() => { throw e2; });

    const errorLog = runTeardown(probe.ctx);

    expect(errorLog).toHaveLength(2);
    expect((errorLog[0] as { origin: string; index: number }).origin).toBe('integration');
    expect((errorLog[0] as { index: number }).index).toBe(0);
    expect((errorLog[1] as { origin: string; index: number }).origin).toBe('integration');
    expect((errorLog[1] as { index: number }).index).toBe(1);
  });
});

describe('runTeardown — step 5 (registry detachment)', () => {
  it('emitter has no handlers after teardown — pre-existing handlers cannot fire', () => {
    const probe = makeTeardownProbe();
    const segmentAddedSpy = vi.fn();
    probe.emitter.on('segmentAdded', segmentAddedSpy);

    runTeardown(probe.ctx);

    // After teardown, the pre-attached handler is gone.
    probe.emitter.emit('segmentAdded', { segment: { id: 'x' } as never });
    expect(segmentAddedSpy).not.toHaveBeenCalled();
  });

  it('integration registry size is 0 after teardown', () => {
    const probe = makeTeardownProbe();
    probe.registry.attach(() => {});
    probe.registry.attach(() => {});
    probe.registry.attach(() => {});

    runTeardown(probe.ctx);

    expect(probe.registry.size).toBe(0);
  });
});

describe('runTeardown — error aggregation', () => {
  it('produces empty errorLog when no callbacks throw', () => {
    const probe = makeTeardownProbe();
    probe.emitter.on('stateDisposed', () => {});
    probe.registry.attach(() => {});

    const errorLog = runTeardown(probe.ctx);

    expect(errorLog).toEqual([]);
  });

  it('runs cleanly with no handlers and no integrations', () => {
    const probe = makeTeardownProbe();
    const errorLog = runTeardown(probe.ctx);
    expect(errorLog).toEqual([]);
    expect(probe.state.current).toBe('disposed');
  });

  it('orders mixed handler+integration errors as handlers-first, integrations-second', () => {
    const probe = makeTeardownProbe();
    const h1 = new Error('h1');
    const i1 = new Error('i1');
    const i2 = new Error('i2');
    probe.emitter.on('stateDisposed', () => { throw h1; });
    probe.registry.attach(() => { throw i1; });
    probe.registry.attach(() => { throw i2; });

    const errorLog = runTeardown(probe.ctx);

    expect(errorLog).toHaveLength(3);
    expect((errorLog[0] as { origin: string }).origin).toBe('handler');
    expect((errorLog[1] as { origin: string }).origin).toBe('integration');
    expect((errorLog[2] as { origin: string }).origin).toBe('integration');
    // Indices are origin-relative: handler index 0, integration indices 0 and 1.
    expect((errorLog[0] as { index: number }).index).toBe(0);
    expect((errorLog[1] as { index: number }).index).toBe(0);
    expect((errorLog[2] as { index: number }).index).toBe(1);
  });
});
