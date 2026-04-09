import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../src/events.js';

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
});
