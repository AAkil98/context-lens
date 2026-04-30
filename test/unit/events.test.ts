import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, type ContextLensEventMap, type StateDisposedEvent } from '../../src/events.js';

interface TestEventMap {
  foo: { value: number };
  bar: { msg: string };
}

describe('EventEmitter', () => {
  describe('on() and emit()', () => {
    it('calls handler with the emitted payload', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const handler = vi.fn();

      emitter.on('foo', handler);
      emitter.emit('foo', { value: 42 });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it('calls multiple handlers for the same event in registration order', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const order: number[] = [];

      emitter.on('foo', () => order.push(1));
      emitter.on('foo', () => order.push(2));
      emitter.on('foo', () => order.push(3));

      emitter.emit('foo', { value: 0 });

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('unsubscribe', () => {
    it('on() returns a function that removes the handler', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const handler = vi.fn();

      const unsub = emitter.on('foo', handler);
      unsub();

      emitter.emit('foo', { value: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribing one handler does not affect others', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      const unsubA = emitter.on('foo', handlerA);
      emitter.on('foo', handlerB);

      unsubA();
      emitter.emit('foo', { value: 5 });

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledOnce();
    });
  });

  describe('once()', () => {
    it('calls handler exactly once then auto-removes', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const handler = vi.fn();

      emitter.once('foo', handler);

      emitter.emit('foo', { value: 1 });
      emitter.emit('foo', { value: 2 });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ value: 1 });
    });

    it('unsubscribe removes handler before first call', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const handler = vi.fn();

      const unsub = emitter.once('foo', handler);
      unsub();

      emitter.emit('foo', { value: 1 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('re-entrancy detection', () => {
    it('logs a warning when emit is called inside a handler', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      emitter.on('foo', () => {
        emitter.emit('bar', { msg: 'nested' });
      });

      const barHandler = vi.fn();
      emitter.on('bar', barHandler);

      emitter.emit('foo', { value: 1 });

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Re-entrant emit detected'),
      );
      expect(barHandler).toHaveBeenCalledWith({ msg: 'nested' });

      warnSpy.mockRestore();
    });
  });

  describe('error swallowing', () => {
    it('does not propagate handler errors', () => {
      const emitter = new EventEmitter<TestEventMap>();

      emitter.on('foo', () => {
        throw new Error('handler blew up');
      });

      expect(() => emitter.emit('foo', { value: 1 })).not.toThrow();
    });

    it('subsequent handlers still run after a handler throws', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const afterHandler = vi.fn();

      emitter.on('foo', () => {
        throw new Error('boom');
      });
      emitter.on('foo', afterHandler);

      emitter.emit('foo', { value: 99 });

      expect(afterHandler).toHaveBeenCalledOnce();
      expect(afterHandler).toHaveBeenCalledWith({ value: 99 });
    });
  });

  describe('edge cases', () => {
    it('emitting an event with no handlers does nothing', () => {
      const emitter = new EventEmitter<TestEventMap>();
      expect(() => emitter.emit('foo', { value: 0 })).not.toThrow();
    });

    it('different events are independent', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const fooHandler = vi.fn();
      const barHandler = vi.fn();

      emitter.on('foo', fooHandler);
      emitter.on('bar', barHandler);

      emitter.emit('foo', { value: 10 });

      expect(fooHandler).toHaveBeenCalledOnce();
      expect(barHandler).not.toHaveBeenCalled();

      emitter.emit('bar', { msg: 'hello' });

      expect(fooHandler).toHaveBeenCalledOnce(); // still just once
      expect(barHandler).toHaveBeenCalledOnce();
    });
  });

  // ─── emitCollect (cl-spec-015 §4.3) ────────────────────────────

  describe('emitCollect', () => {
    it('dispatches handlers in registration order, errorLog stays empty when no throws', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const order: number[] = [];

      emitter.on('foo', () => order.push(1));
      emitter.on('foo', () => order.push(2));
      emitter.on('foo', () => order.push(3));

      const errorLog: unknown[] = [];
      emitter.emitCollect('foo', { value: 0 }, errorLog);

      expect(order).toEqual([1, 2, 3]);
      expect(errorLog).toEqual([]);
    });

    it('pushes thrown values onto errorLog in caught-order; iteration does not abort', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const e1 = new Error('boom-1');
      const e3 = new Error('boom-3');
      let secondRan = false;
      let fourthRan = false;

      emitter.on('foo', () => { throw e1; });
      emitter.on('foo', () => { secondRan = true; });
      emitter.on('foo', () => { throw e3; });
      emitter.on('foo', () => { fourthRan = true; });

      const errorLog: unknown[] = [];
      emitter.emitCollect('foo', { value: 1 }, errorLog);

      expect(errorLog).toHaveLength(2);
      expect(errorLog[0]).toBe(e1);
      expect(errorLog[1]).toBe(e3);
      expect(secondRan).toBe(true);
      expect(fourthRan).toBe(true);
    });

    it('is a no-op when no handlers are registered', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const errorLog: unknown[] = [];

      expect(() => emitter.emitCollect('foo', { value: 1 }, errorLog)).not.toThrow();
      expect(errorLog).toEqual([]);
    });

    it('appends to a non-empty errorLog without disturbing prior entries', () => {
      const emitter = new EventEmitter<TestEventMap>();
      emitter.on('foo', () => { throw new Error('new'); });

      const errorLog: unknown[] = ['preexisting'];
      emitter.emitCollect('foo', { value: 1 }, errorLog);

      expect(errorLog).toHaveLength(2);
      expect(errorLog[0]).toBe('preexisting');
      expect(errorLog[1]).toBeInstanceOf(Error);
      expect((errorLog[1] as Error).message).toBe('new');
    });

    it('does not affect the standard emit() swallow path', () => {
      const emitter = new EventEmitter<TestEventMap>();
      const after = vi.fn();

      emitter.on('foo', () => { throw new Error('boom'); });
      emitter.on('foo', after);

      // Standard emit still swallows
      expect(() => emitter.emit('foo', { value: 1 })).not.toThrow();
      expect(after).toHaveBeenCalledOnce();
    });
  });
});

// ─── ContextLensEventMap / StateDisposedEvent (cl-spec-015 §7.1) ────

describe('stateDisposed event wiring', () => {
  it('event map accepts the documented stateDisposed payload shape', () => {
    const emitter = new EventEmitter<ContextLensEventMap>();
    const payload: StateDisposedEvent = {
      type: 'stateDisposed',
      instanceId: 'cl-1-abc123',
      timestamp: 1234567890,
    };

    let received: StateDisposedEvent | null = null;
    emitter.on('stateDisposed', (p) => { received = p; });
    emitter.emit('stateDisposed', payload);

    expect(received).toEqual(payload);
  });

  it('frozen payload rejects mutations at runtime', () => {
    const payload = Object.freeze({
      type: 'stateDisposed' as const,
      instanceId: 'cl-1-abc123',
      timestamp: 1234567890,
    });

    expect(() => {
      (payload as { instanceId: string }).instanceId = 'mutated';
    }).toThrow(TypeError);
  });
});
