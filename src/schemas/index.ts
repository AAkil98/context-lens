/**
 * Schema module — JSON Schema definitions, toJSON conversion, validation.
 * @see cl-spec-011
 */

import type {
  QualityReport,
  DiagnosticSnapshot,
  EvictionPlan,
} from '../types.js';
import { pickDefs, EMBEDDING_MODE_ENUM } from './defs.js';
import {
  qualityReportToJSON,
  diagnosticSnapshotToJSON,
  evictionPlanToJSON,
} from './to-json.js';
import {
  validateAgainstSchema,
  type ValidationResult,
} from './validate.js';

// ── Schema Version ───────────────────────────────────────────────

export const SCHEMA_VERSION = '1.0.0';

// ── Schema Composition ───────────────────────────────────────────

type S = Record<string, unknown>;

function buildSchema(
  title: string,
  rootProperties: Record<string, S>,
  rootRequired: string[],
  defNames: string[],
): S {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    type: 'object',
    properties: rootProperties,
    required: rootRequired,
    additionalProperties: true,
    $defs: pickDefs(defNames),
  };
}

function ref(name: string): S {
  return { $ref: `#/$defs/${name}` };
}

function nullable(schema: S): S {
  return { oneOf: [schema, { type: 'null' }] };
}

function arr(items: S): S {
  return { type: 'array', items };
}

function strEnum(...values: readonly string[]): S {
  return { type: 'string', enum: [...values] };
}

const str: S = { type: 'string' };
const num: S = { type: 'number' };
const bool: S = { type: 'boolean' };
const score: S = { type: 'number', minimum: 0, maximum: 1 };

// ── QualityReport Schema ─────────────────────────────────────────

const qualityReportSchema = buildSchema(
  'QualityReport',
  {
    schemaVersion: str,
    timestamp: num,
    reportId: str,
    segmentCount: { type: 'integer', minimum: 0 },
    windowScores: ref('WindowScores'),
    rawScores: ref('WindowScores'),
    composite: nullable(score),
    baseline: nullable(ref('BaselineSnapshot')),
    capacity: ref('CapacityReport'),
    tokenizer: ref('TokenizerMetadata'),
    embeddingMode: strEnum(...EMBEDDING_MODE_ENUM),
    segments: arr(ref('SegmentScore')),
    groups: arr(ref('GroupScore')),
    continuity: ref('ContinuitySummary'),
    trend: nullable(ref('TrendData')),
    patterns: ref('DetectionResult'),
    task: ref('TaskSummary'),
  },
  [
    'schemaVersion', 'timestamp', 'reportId', 'segmentCount',
    'windowScores', 'rawScores', 'composite', 'baseline',
    'capacity', 'tokenizer', 'embeddingMode',
    'segments', 'groups', 'continuity', 'trend',
    'patterns', 'task',
  ],
  [
    'WindowScores', 'BaselineSnapshot', 'SegmentScore', 'RedundancyInfo',
    'GroupScore', 'ContinuitySummary', 'ContinuityEvent', 'TrendData',
    'CapacityReport', 'TokenizerMetadata',
    'DetectionResult', 'ActivePattern', 'PatternSignature', 'ScoreRef',
    'ThresholdRef', 'RemediationHint', 'CompoundContext',
    'TaskSummary',
  ],
);

// ── DiagnosticSnapshot Schema ────────────────────────────────────

const diagnosticSnapshotSchema = buildSchema(
  'DiagnosticSnapshot',
  {
    schemaVersion: str,
    timestamp: num,
    sessionDuration: num,
    latestReport: nullable(ref('QualityReport')),
    reportHistory: ref('ReportHistorySummary'),
    patternSummary: ref('PatternSummary'),
    timeline: arr(ref('TimelineEntry')),
    performance: ref('PerformanceSummary'),
    providers: ref('ProviderSummary'),
    segmentCount: { type: 'integer', minimum: 0 },
    groupCount: { type: 'integer', minimum: 0 },
    evictedCount: { type: 'integer', minimum: 0 },
    taskState: ref('TaskState'),
    continuityLedger: arr(ref('ContinuityEvent')),
    warnings: arr(ref('Warning')),
  },
  [
    'schemaVersion', 'timestamp', 'sessionDuration',
    'latestReport', 'reportHistory', 'patternSummary',
    'timeline', 'performance', 'providers',
    'segmentCount', 'groupCount', 'evictedCount',
    'taskState', 'continuityLedger', 'warnings',
  ],
  [
    // QualityReport types (for latestReport)
    'WindowScores', 'BaselineSnapshot', 'SegmentScore', 'RedundancyInfo',
    'GroupScore', 'ContinuitySummary', 'ContinuityEvent', 'TrendData',
    'CapacityReport', 'TokenizerMetadata',
    'DetectionResult', 'ActivePattern', 'PatternSignature', 'ScoreRef',
    'ThresholdRef', 'RemediationHint', 'CompoundContext',
    'TaskSummary',
    // Diagnostic-specific types
    'TaskState', 'TaskDescriptor', 'TaskTransition', 'TransitionEntry',
    'ReportHistorySummary', 'ReportSummary', 'AnomalyFlag',
    'RollingTrend', 'TrendLine',
    'PatternSummary', 'PatternStats', 'PatternHistoryEntry',
    'TimelineEntry',
    'PerformanceSummary', 'OperationTimingStats', 'CacheReport', 'CacheMetrics',
    'ProviderSummary', 'EmbeddingProviderMetadata',
    'Warning',
  ],
);

// The DiagnosticSnapshot embeds a full QualityReport.
// Add it as a $def so latestReport can $ref it.
const diagDefs = diagnosticSnapshotSchema['$defs'] as Record<string, S>;
diagDefs['QualityReport'] = {
  type: 'object',
  properties: (qualityReportSchema as S)['properties'],
  required: (qualityReportSchema as S)['required'],
  additionalProperties: true,
};

// ── EvictionPlan Schema ──────────────────────────────────────────

const evictionPlanSchema = buildSchema(
  'EvictionPlan',
  {
    schemaVersion: str,
    planId: str,
    timestamp: num,
    strategy: strEnum('default', 'saturation', 'erosion', 'gap', 'collapse'),
    target: ref('PlanTarget'),
    candidates: arr(ref('EvictionCandidate')),
    candidateCount: { type: 'integer', minimum: 0 },
    totalReclaimable: { type: 'integer', minimum: 0 },
    targetMet: bool,
    shortfall: { type: 'integer', minimum: 0 },
    seedsIncluded: bool,
    exhausted: bool,
    qualityImpact: ref('ProjectedQualityImpact'),
    patterns: arr(str), // PatternName[]
    reportId: str,
  },
  [
    'schemaVersion', 'planId', 'timestamp', 'strategy',
    'target', 'candidates', 'candidateCount', 'totalReclaimable',
    'targetMet', 'shortfall', 'seedsIncluded', 'exhausted',
    'qualityImpact', 'patterns', 'reportId',
  ],
  [
    'PlanTarget', 'EvictionCandidate', 'CandidateScores', 'CandidateImpact',
    'ProjectedQualityImpact', 'CompactionRecommendation',
  ],
);

// ── Public API ───────────────────────────────────────────────────

/** Static schema exports — no ContextLens instance needed. */
export const schemas = {
  qualityReport: qualityReportSchema,
  diagnosticSnapshot: diagnosticSnapshotSchema,
  evictionPlan: evictionPlanSchema,
  version: SCHEMA_VERSION,
} as const;

/**
 * Converts typed output objects to schema-conforming plain objects.
 * Sets schemaVersion automatically. Safe to pass to JSON.stringify.
 * @see cl-spec-011 §9.3
 */
export function toJSON(output: QualityReport): Record<string, unknown>;
export function toJSON(output: DiagnosticSnapshot): Record<string, unknown>;
export function toJSON(output: EvictionPlan): Record<string, unknown>;
export function toJSON(output: QualityReport | DiagnosticSnapshot | EvictionPlan): Record<string, unknown> {
  // Discriminate by unique fields
  if ('reportId' in output && 'windowScores' in output && !('planId' in output)) {
    return qualityReportToJSON(output as QualityReport);
  }
  if ('sessionDuration' in output) {
    return diagnosticSnapshotToJSON(output as DiagnosticSnapshot);
  }
  if ('planId' in output) {
    return evictionPlanToJSON(output as EvictionPlan);
  }
  // Fallback: treat as QualityReport
  return qualityReportToJSON(output as QualityReport);
}

/**
 * Validates plain objects against context-lens schemas.
 * Returns { valid, errors }. Structural validation only.
 * @see cl-spec-011 §9.4
 */
export const validate = {
  qualityReport(obj: unknown): ValidationResult {
    return validateAgainstSchema(obj as Record<string, unknown>, qualityReportSchema as Record<string, unknown>);
  },
  diagnosticSnapshot(obj: unknown): ValidationResult {
    return validateAgainstSchema(obj as Record<string, unknown>, diagnosticSnapshotSchema as Record<string, unknown>);
  },
  evictionPlan(obj: unknown): ValidationResult {
    return validateAgainstSchema(obj as Record<string, unknown>, evictionPlanSchema as Record<string, unknown>);
  },
};

// Re-export types
export type { ValidationResult, ValidationError } from './validate.js';
