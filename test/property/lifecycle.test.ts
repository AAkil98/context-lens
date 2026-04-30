/**
 * Phase 6 — property-based tests for instance lifecycle (cl-spec-015).
 *
 * Four properties from impl-spec I-06 §5:
 *   1. dispose-idempotent: any prefix + N≥1 dispose calls → exactly one
 *      stateDisposed event; isDisposed true after every call.
 *   2. post-disposal-uniformity: every non-exempt public method throws
 *      DisposedError after dispose(), regardless of arguments.
 *   3. state-machine-mutual-exclusion: isDisposed && isDisposing is never
 *      true at any observable moment.
 *   4. read-only-classification-completeness: every public method on
 *      ContextLens is classified exactly once as either read-only,
 *      mutating, or lifecycle-exempt.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ContextLens } from '../../src/index.js';
import { DisposedError } from '../../src/errors.js';
import { READ_ONLY_METHODS } from '../../src/lifecycle.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeLens(): ContextLens {
  return new ContextLens({ capacity: 10000 });
}

function distinctContent(index: number): string {
  const topics = [
    'The quick brown fox jumps over the lazy dog near the riverbank during sunrise',
    'Quantum computing leverages superposition and entanglement to solve problems',
    'Photosynthesis converts carbon dioxide and water into glucose and oxygen',
    'Medieval castle architecture included moats drawbridges and thick stone walls',
    'Machine learning algorithms train on large datasets to recognize patterns',
    'Ocean currents distribute heat around the globe affecting weather and climate',
  ];
  return topics[index % topics.length]!;
}

// Public API surface from cl-spec-007 §6 + cl-spec-015 §2.5.
// Excludes the four always-valid lifecycle surfaces (dispose, isDisposed,
// isDisposing, instanceId) — those have separate exemption semantics.
const PUBLIC_METHODS_SYNC = [
  // mutating (sync)
  'seed', 'add', 'update', 'replace', 'compact', 'split', 'evict', 'restore',
  'createGroup', 'dissolveGroup',
  'clearTask',
  'setTokenizer',
  'setCapacity', 'registerPattern',
  'attachIntegration', 'on',
  // read-only
  'getCapacity', 'getSegment', 'getSegmentCount', 'listSegments',
  'listGroups', 'getGroup',
  'getTask', 'getTaskState',
  'getDiagnostics', 'assess', 'planEviction', 'snapshot',
  'getEvictedSegments',
  'getTokenizerInfo', 'getEmbeddingProviderInfo',
  'getBaseline', 'getConstructionTimestamp', 'getConfig',
  'getPerformance', 'getDetection',
] as const;

const PUBLIC_METHODS_ASYNC = ['setTask', 'setEmbeddingProvider'] as const;

const ALL_PUBLIC_METHODS = [...PUBLIC_METHODS_SYNC, ...PUBLIC_METHODS_ASYNC] as const;

const KNOWN_MUTATING = new Set<string>([
  'seed', 'add', 'update', 'replace', 'compact', 'split', 'evict', 'restore',
  'createGroup', 'dissolveGroup',
  'setTask', 'clearTask',
  'setTokenizer', 'setEmbeddingProvider',
  'setCapacity', 'registerPattern',
  'attachIntegration', 'on',
]);

const EXEMPT_NAMES = new Set<string>(['dispose', 'isDisposed', 'isDisposing', 'instanceId']);

/** Dispatch a public sync method by name with minimal valid arguments. */
function callSync(lens: ContextLens, name: string): void {
  switch (name) {
    case 'seed': lens.seed([{ content: 'x' }]); return;
    case 'add': lens.add('x'); return;
    case 'update': lens.update('any-id', { content: 'y' }); return;
    case 'replace': lens.replace('any-id', 'y'); return;
    case 'compact': lens.compact('any-id', 'short'); return;
    case 'split': lens.split('any-id', () => ['a', 'b']); return;
    case 'evict': lens.evict('any-id'); return;
    case 'restore': lens.restore('any-id'); return;
    case 'createGroup': lens.createGroup('g', []); return;
    case 'dissolveGroup': lens.dissolveGroup('g'); return;
    case 'getGroup': lens.getGroup('g'); return;
    case 'listGroups': lens.listGroups(); return;
    case 'getSegment': lens.getSegment('any-id'); return;
    case 'getSegmentCount': lens.getSegmentCount(); return;
    case 'listSegments': lens.listSegments(); return;
    case 'getCapacity': lens.getCapacity(); return;
    case 'assess': lens.assess(); return;
    case 'planEviction': lens.planEviction(); return;
    case 'clearTask': lens.clearTask(); return;
    case 'getTask': lens.getTask(); return;
    case 'getTaskState': lens.getTaskState(); return;
    case 'setTokenizer': lens.setTokenizer('approximate'); return;
    case 'getTokenizerInfo': lens.getTokenizerInfo(); return;
    case 'getEmbeddingProviderInfo': lens.getEmbeddingProviderInfo(); return;
    case 'setCapacity': lens.setCapacity(5000); return;
    case 'registerPattern': lens.registerPattern({
      name: 'x', description: 'x', detect: () => null,
    }); return;
    case 'getBaseline': lens.getBaseline(); return;
    case 'getDiagnostics': lens.getDiagnostics(); return;
    case 'getConstructionTimestamp': lens.getConstructionTimestamp(); return;
    case 'getConfig': lens.getConfig(); return;
    case 'getEvictedSegments': lens.getEvictedSegments(); return;
    case 'getPerformance': lens.getPerformance(); return;
    case 'getDetection': lens.getDetection(); return;
    case 'snapshot': lens.snapshot(); return;
    case 'attachIntegration': lens.attachIntegration(() => {}); return;
    case 'on': lens.on('segmentAdded', () => {}); return;
    default: throw new Error(`Unhandled sync method in property test: ${name}`);
  }
}

/** Dispatch a public async method by name with minimal valid arguments. */
function callAsync(lens: ContextLens, name: string): Promise<unknown> {
  switch (name) {
    case 'setTask': return lens.setTask({ description: 'x' });
    case 'setEmbeddingProvider': return lens.setEmbeddingProvider(null);
    default: throw new Error(`Unhandled async method in property test: ${name}`);
  }
}

// ─── Properties ─────────────────────────────────────────────────

describe('Phase 6 — Property-Based Tests (cl-spec-015)', () => {

  // Property 1
  describe('Idempotent dispose', () => {
    it('any prefix of operations + N ≥ 1 dispose calls fires stateDisposed exactly once', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 0, max: 5 }),
          (n, prefix) => {
            const lens = makeLens();
            for (let i = 0; i < prefix; i++) lens.add(distinctContent(i));

            let count = 0;
            lens.on('stateDisposed', () => { count++; });

            for (let i = 0; i < n; i++) lens.dispose();

            expect(count).toBe(1);
            expect(lens.isDisposed).toBe(true);
            expect(lens.isDisposing).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Property 2
  describe('Post-disposal uniformity', () => {
    it('every public method throws DisposedError after dispose()', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...ALL_PUBLIC_METHODS), async (name) => {
          const lens = makeLens();
          lens.dispose();

          if ((PUBLIC_METHODS_ASYNC as readonly string[]).includes(name)) {
            await expect(callAsync(lens, name)).rejects.toBeInstanceOf(DisposedError);
          } else {
            try {
              callSync(lens, name);
              expect.fail(`${name} should have thrown DisposedError`);
            } catch (e) {
              expect(e).toBeInstanceOf(DisposedError);
              expect((e as DisposedError).attemptedMethod).toBe(name);
              expect((e as DisposedError).instanceId).toBe(lens.instanceId);
            }
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  // Property 3
  describe('State-machine mutual exclusion', () => {
    it('isDisposed && isDisposing is never simultaneously true at any observable moment', () => {
      fc.assert(
        fc.property(
          fc.boolean(),  // attach a stateDisposed handler?
          fc.boolean(),  // attach an integration?
          fc.integer({ min: 0, max: 5 }),  // pre-dispose segments
          (subscribe, integrate, prefix) => {
            const lens = makeLens();
            for (let i = 0; i < prefix; i++) lens.add(distinctContent(i));

            const observations: boolean[] = [];
            const observe = (d: boolean, di: boolean) => observations.push(d && di);

            // Before dispose.
            observe(lens.isDisposed, lens.isDisposing);

            if (subscribe) {
              lens.on('stateDisposed', () => {
                observe(lens.isDisposed, lens.isDisposing);
              });
            }
            if (integrate) {
              lens.attachIntegration((live) => {
                observe(live.isDisposed, live.isDisposing);
              });
            }

            lens.dispose();

            // After dispose.
            observe(lens.isDisposed, lens.isDisposing);

            for (const o of observations) {
              expect(o).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Property 4
  describe('Read-only classification completeness', () => {
    it('every public method is classified exactly once as read-only, mutating, or exempt', () => {
      fc.assert(
        fc.property(fc.constantFrom(...ALL_PUBLIC_METHODS), (name) => {
          const isReadOnly = READ_ONLY_METHODS.has(name);
          const isMutating = KNOWN_MUTATING.has(name);
          const isExempt = EXEMPT_NAMES.has(name);

          const total = (isReadOnly ? 1 : 0) + (isMutating ? 1 : 0) + (isExempt ? 1 : 0);
          expect(total).toBe(1);
        }),
      );
    });

    it('the exempt-name set has exactly the four always-valid lifecycle surfaces', () => {
      // Static cross-check: cl-spec-015 §2.5 lists dispose, isDisposed, isDisposing, instanceId.
      expect(EXEMPT_NAMES.size).toBe(4);
      expect(EXEMPT_NAMES.has('dispose')).toBe(true);
      expect(EXEMPT_NAMES.has('isDisposed')).toBe(true);
      expect(EXEMPT_NAMES.has('isDisposing')).toBe(true);
      expect(EXEMPT_NAMES.has('instanceId')).toBe(true);
    });

    it('every public method actually exists on a constructed instance', () => {
      // Sanity: PUBLIC_METHODS list isn't out of sync with the runtime class.
      const lens = makeLens();
      for (const name of ALL_PUBLIC_METHODS) {
        expect(typeof (lens as unknown as Record<string, unknown>)[name])
          .toBe('function');
      }
    });

    it('READ_ONLY_METHODS and KNOWN_MUTATING are disjoint', () => {
      for (const name of READ_ONLY_METHODS) {
        expect(KNOWN_MUTATING.has(name)).toBe(false);
      }
      for (const name of KNOWN_MUTATING) {
        expect(READ_ONLY_METHODS.has(name)).toBe(false);
      }
    });
  });
});
