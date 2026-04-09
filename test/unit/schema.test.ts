import { describe, it, expect } from 'vitest';
import { ContextLens, schemas, toJSON, validate, SCHEMA_VERSION } from '../../src/index.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeLens(capacity = 10000): ContextLens {
  return new ContextLens({ capacity });
}

function distinctContent(index: number): string {
  const topics = [
    'The quick brown fox jumps over the lazy dog near the riverbank during sunrise on a warm summer morning',
    'Quantum computing leverages superposition and entanglement to solve complex optimization problems faster',
    'Photosynthesis converts carbon dioxide and water into glucose and oxygen using sunlight as energy',
    'The architecture of medieval castles included moats drawbridges and thick stone walls for defense',
    'Machine learning algorithms train on large datasets to recognize patterns and make predictions accurately',
    'Ocean currents distribute heat around the globe affecting weather patterns and marine ecosystems significantly',
  ];
  return topics[index % topics.length]!;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Schema — Unit Tests', () => {
  // ── Static schema exports ────────────────────────────────────

  describe('Static schema exports', () => {
    it('exports all three schema objects', () => {
      expect(schemas.qualityReport).toBeDefined();
      expect(schemas.diagnosticSnapshot).toBeDefined();
      expect(schemas.evictionPlan).toBeDefined();
    });

    it('exports schema version', () => {
      expect(SCHEMA_VERSION).toBe('1.0.0');
      expect(schemas.version).toBe(SCHEMA_VERSION);
    });

    it('schemas are draft 2020-12', () => {
      for (const schema of [schemas.qualityReport, schemas.diagnosticSnapshot, schemas.evictionPlan]) {
        expect((schema as Record<string, unknown>)['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      }
    });

    it('schemas have $defs for shared types', () => {
      for (const schema of [schemas.qualityReport, schemas.diagnosticSnapshot, schemas.evictionPlan]) {
        expect((schema as Record<string, unknown>)['$defs']).toBeDefined();
        expect(typeof (schema as Record<string, unknown>)['$defs']).toBe('object');
      }
    });
  });

  // ── toJSON + validate: QualityReport ─────────────────────────

  describe('QualityReport toJSON/validate', () => {
    it('converts a multi-segment report to valid JSON', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.add(distinctContent(2));
      const report = lens.assess();

      const json = toJSON(report);
      expect(json['schemaVersion']).toBe(SCHEMA_VERSION);
      expect(typeof json['timestamp']).toBe('number');
      expect(typeof json['reportId']).toBe('string');

      const result = validate.qualityReport(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('converts an empty-window report (null composite)', () => {
      const lens = makeLens(10000);
      const report = lens.assess();

      expect(report.composite).toBeNull();

      const json = toJSON(report);
      expect(json['composite']).toBeNull();

      const result = validate.qualityReport(json);
      expect(result.valid).toBe(true);
    });

    it('survives JSON round-trip', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      const report = lens.assess();

      const json = toJSON(report);
      const serialized = JSON.stringify(json);
      const parsed = JSON.parse(serialized) as Record<string, unknown>;

      const result = validate.qualityReport(parsed);
      expect(result.valid).toBe(true);
      expect(parsed['reportId']).toBe(json['reportId']);
      expect(parsed['segmentCount']).toBe(json['segmentCount']);
    });
  });

  // ── toJSON + validate: DiagnosticSnapshot ────────────────────

  describe('DiagnosticSnapshot toJSON/validate', () => {
    it('converts diagnostics to valid JSON', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.assess();
      const diag = lens.getDiagnostics();

      const json = toJSON(diag);
      expect(json['schemaVersion']).toBe(SCHEMA_VERSION);

      const result = validate.diagnosticSnapshot(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('handles diagnostics with null latestReport', () => {
      const lens = makeLens(10000);
      const diag = lens.getDiagnostics();

      const json = toJSON(diag);
      expect(json['latestReport']).toBeNull();

      const result = validate.diagnosticSnapshot(json);
      expect(result.valid).toBe(true);
    });
  });

  // ── toJSON + validate: EvictionPlan ──────────────────────────

  describe('EvictionPlan toJSON/validate', () => {
    it('converts an eviction plan to valid JSON', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.add(distinctContent(2));
      lens.assess();
      const plan = lens.planEviction();

      const json = toJSON(plan);
      expect(json['schemaVersion']).toBe(SCHEMA_VERSION);
      expect(typeof json['planId']).toBe('string');

      const result = validate.evictionPlan(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── validate: rejection of malformed objects ─────────────────

  describe('Validation rejects malformed objects', () => {
    it('rejects missing required fields', () => {
      const result = validate.qualityReport({ schemaVersion: '1.0.0' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects wrong types', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      const report = lens.assess();
      const json = toJSON(report) as Record<string, unknown>;

      // Tamper with a field
      json['segmentCount'] = 'not-a-number';

      const result = validate.qualityReport(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path.includes('segmentCount'))).toBe(true);
    });

    it('rejects empty object for diagnosticSnapshot', () => {
      const result = validate.diagnosticSnapshot({});
      expect(result.valid).toBe(false);
    });

    it('rejects empty object for evictionPlan', () => {
      const result = validate.evictionPlan({});
      expect(result.valid).toBe(false);
    });

    it('rejects score values > 1', () => {
      const lens = makeLens(10000);
      lens.add(distinctContent(0));
      const report = lens.assess();
      const json = toJSON(report) as Record<string, unknown>;

      // Tamper with composite
      json['composite'] = 1.5;

      const result = validate.qualityReport(json);
      expect(result.valid).toBe(false);
    });
  });

  // ── Shared $defs consistency ─────────────────────────────────

  describe('Shared $defs consistency', () => {
    it('WindowScores def is identical across schemas that use it', () => {
      const qrDefs = (schemas.qualityReport as Record<string, unknown>)['$defs'] as Record<string, unknown>;
      const dsDefs = (schemas.diagnosticSnapshot as Record<string, unknown>)['$defs'] as Record<string, unknown>;

      const qrWindowScores = JSON.stringify(qrDefs['WindowScores']);
      const dsWindowScores = JSON.stringify(dsDefs['WindowScores']);

      expect(qrWindowScores).toBe(dsWindowScores);
    });

    it('CapacityReport def is identical across schemas that use it', () => {
      const qrDefs = (schemas.qualityReport as Record<string, unknown>)['$defs'] as Record<string, unknown>;
      const dsDefs = (schemas.diagnosticSnapshot as Record<string, unknown>)['$defs'] as Record<string, unknown>;

      const qrCap = JSON.stringify(qrDefs['CapacityReport']);
      const dsCap = JSON.stringify(dsDefs['CapacityReport']);

      expect(qrCap).toBe(dsCap);
    });
  });

  // ── Phase C: Branch coverage additions ───────────────────────

  describe('validate() with oneOf (nullable) failure', () => {
    it('rejects wrong non-null type for nullable field', () => {
      const lens = makeLens();
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      const report = lens.assess();
      const json = toJSON(report) as Record<string, unknown>;
      // baseline can be null or BaselineSnapshot object — set to a string (wrong type)
      json['baseline'] = 'not-an-object';
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validate() with array constraints', () => {
    it('rejects segments field as non-array', () => {
      const lens = makeLens();
      lens.add(distinctContent(0));
      const report = lens.assess();
      const json = toJSON(report) as Record<string, unknown>;
      json['segments'] = 'not-an-array';
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(false);
    });
  });

  describe('toJSON with all nullable fields populated', () => {
    it('produces valid JSON when trend, baseline, and task are all populated', async () => {
      const lens = makeLens();
      lens.seed([{ content: distinctContent(0) }, { content: distinctContent(1) }]);
      lens.add(distinctContent(2));
      await lens.setTask({ description: 'Test task for full population', keywords: ['test'] });
      lens.assess(); // First assessment (for trend computation)
      lens.add(distinctContent(3));
      const report = lens.assess(); // Second assessment (trend populated)
      const json = toJSON(report);
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(true);
    });
  });

  describe('toJSON with null composite (empty window)', () => {
    it('validates when composite is null', () => {
      const lens = makeLens();
      const report = lens.assess();
      expect(report.composite).toBeNull();
      const json = toJSON(report);
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(true);
    });
  });

  describe('validate() rejects incorrect nested object types', () => {
    it('rejects capacity with string utilization', () => {
      const lens = makeLens();
      lens.add(distinctContent(0));
      const report = lens.assess();
      const json = toJSON(report) as Record<string, unknown>;
      (json['capacity'] as Record<string, unknown>)['utilization'] = 'high';
      const result = validate.qualityReport(json);
      expect(result.valid).toBe(false);
    });
  });

  describe('Diagnostic snapshot validation edge cases', () => {
    it('validates diagnostics with populated report history', () => {
      const lens = makeLens();
      lens.add(distinctContent(0));
      lens.add(distinctContent(1));
      lens.assess();
      lens.add(distinctContent(2));
      lens.assess();
      const diag = lens.getDiagnostics();
      const json = toJSON(diag);
      const result = validate.diagnosticSnapshot(json);
      expect(result.valid).toBe(true);
    });
  });
});
