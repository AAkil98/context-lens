import { describe, it, expect } from 'vitest';
import { IntegrationRegistry } from '../../src/lifecycle.js';
import type { IntegrationHandle } from '../../src/types.js';

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
