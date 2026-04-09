import { describe, it, expect, beforeEach } from 'vitest';
import { TaskManager } from '../../src/task.js';
import { SimilarityEngine } from '../../src/similarity.js';
import { ValidationError } from '../../src/errors.js';

function makeSim(): SimilarityEngine {
  return new SimilarityEngine();
}

describe('TaskManager', () => {
  let tm: TaskManager;
  let sim: SimilarityEngine;

  beforeEach(() => {
    tm = new TaskManager();
    sim = makeSim();
  });

  // ── Validation ───────────────────────────────────────────────────

  describe('validation', () => {
    it('throws on empty description', async () => {
      await expect(tm.setTask({ description: '' }, sim, null)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws on whitespace-only description', async () => {
      await expect(
        tm.setTask({ description: '   ' }, sim, null),
      ).rejects.toThrow(ValidationError);
    });

    it('throws when description exceeds 2000 characters', async () => {
      const longDesc = 'a'.repeat(2001);
      await expect(
        tm.setTask({ description: longDesc }, sim, null),
      ).rejects.toThrow(ValidationError);
    });

    it('throws on non-string keyword', async () => {
      await expect(
        tm.setTask(
          { description: 'valid', keywords: ['' as string] },
          sim,
          null,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws when more than 50 unique keywords after dedup', async () => {
      const keywords = Array.from({ length: 51 }, (_, i) => `kw${i}`);
      await expect(
        tm.setTask({ description: 'valid', keywords }, sim, null),
      ).rejects.toThrow(ValidationError);
    });
  });

  // ── Normalization ────────────────────────────────────────────────

  describe('normalization', () => {
    it('collapses whitespace in description', async () => {
      await tm.setTask({ description: '  hello   world  ' }, sim, null);
      const task = tm.getCurrentTask();
      expect(task!.description).toBe('hello world');
    });

    it('deduplicates keywords case-insensitively, keeps first casing', async () => {
      await tm.setTask(
        { description: 'test', keywords: ['Auth', 'auth', 'AUTH'] },
        sim,
        null,
      );
      const task = tm.getCurrentTask();
      expect(task!.keywords).toEqual(['Auth']);
    });

    it('sorts keywords alphabetically', async () => {
      await tm.setTask(
        { description: 'test', keywords: ['zeta', 'alpha', 'beta'] },
        sim,
        null,
      );
      const task = tm.getCurrentTask();
      expect(task!.keywords).toEqual(['alpha', 'beta', 'zeta']);
    });
  });

  // ── Transitions ──────────────────────────────────────────────────

  describe('transitions', () => {
    it('first setTask returns type "new"', async () => {
      const t = await tm.setTask({ description: 'first task' }, sim, null);
      expect(t.type).toBe('new');
      expect(t.previousTask).toBeNull();
    });

    it('identical descriptor returns type "same"', async () => {
      await tm.setTask({ description: 'first task' }, sim, null);
      const t = await tm.setTask({ description: 'first task' }, sim, null);
      expect(t.type).toBe('same');
    });

    it('similar description returns type "refinement"', async () => {
      // Descriptions that share many trigrams → similarity >= 0.7
      await tm.setTask(
        { description: 'implement the user authentication module' },
        sim,
        null,
      );
      const t = await tm.setTask(
        { description: 'implement the user authentication module with OAuth' },
        sim,
        null,
      );
      expect(t.type).toBe('refinement');
      expect(t.similarity).toBeDefined();
      expect(t.similarity!).toBeGreaterThanOrEqual(0.7);
    });

    it('very different description returns type "change"', async () => {
      await tm.setTask(
        { description: 'implement user authentication' },
        sim,
        null,
      );
      const t = await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      expect(t.type).toBe('change');
    });

    it('same description but different metadata returns refinement', async () => {
      await tm.setTask(
        { description: 'build login', keywords: ['auth'] },
        sim,
        null,
      );
      const t = await tm.setTask(
        { description: 'build login', keywords: ['auth', 'session'] },
        sim,
        null,
      );
      expect(t.type).toBe('refinement');
      expect(t.similarity).toBe(1.0);
    });
  });

  // ── Grace period ─────────────────────────────────────────────────

  describe('grace period', () => {
    it('activates on "change" with remaining=2', async () => {
      await tm.setTask(
        { description: 'implement user authentication' },
        sim,
        null,
      );
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      const state = tm.getState();
      expect(state.gracePeriodActive).toBe(true);
      expect(state.gracePeriodRemaining).toBe(2);
    });

    it('does NOT activate on "refinement"', async () => {
      await tm.setTask(
        { description: 'implement the user authentication module' },
        sim,
        null,
      );
      await tm.setTask(
        { description: 'implement the user authentication module with OAuth' },
        sim,
        null,
      );
      const state = tm.getState();
      expect(state.gracePeriodActive).toBe(false);
    });

    it('counts down via tickReport and deactivates', async () => {
      await tm.setTask(
        { description: 'implement user authentication' },
        sim,
        null,
      );
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );

      tm.tickReport();
      expect(tm.getState().gracePeriodRemaining).toBe(1);
      expect(tm.getState().gracePeriodActive).toBe(true);

      tm.tickReport();
      expect(tm.getState().gracePeriodRemaining).toBe(0);
      expect(tm.getState().gracePeriodActive).toBe(false);
    });

    it('restarts on a second change during grace', async () => {
      await tm.setTask({ description: 'task about alpha topic' }, sim, null);
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      tm.tickReport();
      expect(tm.getState().gracePeriodRemaining).toBe(1);

      // Another change during grace
      await tm.setTask(
        { description: 'completely different third project setup' },
        sim,
        null,
      );
      expect(tm.getState().gracePeriodRemaining).toBe(2);
      expect(tm.getState().gracePeriodActive).toBe(true);
    });
  });

  // ── Staleness ────────────────────────────────────────────────────

  describe('staleness', () => {
    it('becomes stale after 5 reports', async () => {
      await tm.setTask({ description: 'implement feature' }, sim, null);
      expect(tm.isStale()).toBe(false);

      for (let i = 0; i < 4; i++) tm.tickReport();
      expect(tm.isStale()).toBe(false);

      tm.tickReport(); // 5th
      expect(tm.isStale()).toBe(true);
    });

    it('resets staleness on any setTask including "same"', async () => {
      await tm.setTask({ description: 'implement feature' }, sim, null);
      for (let i = 0; i < 5; i++) tm.tickReport();
      expect(tm.isStale()).toBe(true);

      // Re-set the same task
      await tm.setTask({ description: 'implement feature' }, sim, null);
      expect(tm.isStale()).toBe(false);
    });

    it('is not stale when no task is set', () => {
      expect(tm.isStale()).toBe(false);
    });
  });

  // ── History ──────────────────────────────────────────────────────

  describe('history', () => {
    it('records entries for new, refinement, change, and clear', async () => {
      // new
      await tm.setTask(
        { description: 'implement the user authentication module' },
        sim,
        null,
      );
      // refinement
      await tm.setTask(
        { description: 'implement the user authentication module with OAuth' },
        sim,
        null,
      );
      // change
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      // clear
      tm.clearTask();

      const history = tm.getState().transitionHistory;
      const types = history.map((e) => e.type);
      expect(types).toEqual(['new', 'refinement', 'change', 'clear']);
    });

    it('does not record history for "same" transitions', async () => {
      await tm.setTask({ description: 'implement feature' }, sim, null);
      await tm.setTask({ description: 'implement feature' }, sim, null);
      await tm.setTask({ description: 'implement feature' }, sim, null);

      const history = tm.getState().transitionHistory;
      expect(history).toHaveLength(1); // only 'new'
    });

    it('truncates descriptions to 200 characters in history', async () => {
      const longDesc = 'x'.repeat(300);
      await tm.setTask({ description: longDesc }, sim, null);
      const entry = tm.getState().transitionHistory[0]!;
      expect(entry.newDescription!.length).toBe(200);
    });
  });

  // ── clearTask ────────────────────────────────────────────────────

  describe('clearTask', () => {
    it('returns to unset state', async () => {
      await tm.setTask({ description: 'implement feature' }, sim, null);
      tm.clearTask();

      expect(tm.isActive()).toBe(false);
      expect(tm.getCurrentTask()).toBeNull();
      expect(tm.getState().state).toBe('unset');
    });

    it('clears grace period', async () => {
      await tm.setTask(
        { description: 'implement user authentication' },
        sim,
        null,
      );
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      expect(tm.getState().gracePeriodActive).toBe(true);

      tm.clearTask();
      expect(tm.getState().gracePeriodActive).toBe(false);
      expect(tm.getState().gracePeriodRemaining).toBe(0);
    });

    it('returns transition with previousTask', async () => {
      await tm.setTask(
        { description: 'implement feature', keywords: ['test'] },
        sim,
        null,
      );
      const t = tm.clearTask();
      expect(t.type).toBe('clear');
      expect(t.previousTask).not.toBeNull();
      expect(t.previousTask!.description).toBe('implement feature');
    });
  });

  // ── Immutability ─────────────────────────────────────────────────

  describe('immutability', () => {
    it('mutating returned descriptor does not affect internal state', async () => {
      await tm.setTask(
        { description: 'implement feature', keywords: ['auth', 'login'] },
        sim,
        null,
      );

      const task = tm.getCurrentTask()!;
      task.description = 'mutated';
      task.keywords!.push('hacked');

      const internal = tm.getCurrentTask()!;
      expect(internal.description).toBe('implement feature');
      expect(internal.keywords).toEqual(['auth', 'login']);
    });
  });

  // ── Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('defaults refinementThreshold to 0.7', () => {
      const mgr = new TaskManager();
      expect(mgr.getState().state).toBe('unset');
    });

    it('accepts custom refinementThreshold', () => {
      const mgr = new TaskManager(0.5);
      expect(mgr.getState().state).toBe('unset');
    });

    it('throws for out-of-range refinementThreshold', () => {
      expect(() => new TaskManager(0.05)).toThrow(ValidationError);
      expect(() => new TaskManager(0.96)).toThrow(ValidationError);
    });
  });

  // ── Query methods ────────────────────────────────────────────────

  describe('query methods', () => {
    it('isActive returns false when unset', () => {
      expect(tm.isActive()).toBe(false);
    });

    it('isActive returns true when task is set', async () => {
      await tm.setTask({ description: 'task' }, sim, null);
      expect(tm.isActive()).toBe(true);
    });

    it('getSummary reflects current state', async () => {
      const summary1 = tm.getSummary();
      expect(summary1.state).toBe('unset');
      expect(summary1.stale).toBe(false);

      await tm.setTask({ description: 'task' }, sim, null);
      const summary2 = tm.getSummary();
      expect(summary2.state).toBe('active');
    });

    it('getState includes transitionCount', async () => {
      await tm.setTask({ description: 'first' }, sim, null);
      await tm.setTask(
        { description: 'design database schema for payments' },
        sim,
        null,
      );
      const state = tm.getState();
      expect(state.transitionCount).toBe(2);
    });
  });
});
