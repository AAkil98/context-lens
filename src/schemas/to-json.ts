/**
 * toJSON — converts typed output objects to schema-conforming plain objects.
 * Handles optional-to-nullable normalization and schemaVersion injection.
 * @see cl-spec-011 §9.3
 */

import type {
  QualityReport,
  DiagnosticSnapshot,
  EvictionPlan,
  TaskDescriptor,
  TaskState,
  TaskTransition,
  TransitionEntry,
} from '../types.js';
import { SCHEMA_VERSION } from './index.js';

// ── Normalization helpers ────────────────────────────────────────

function normalizeDescriptor(desc: TaskDescriptor | null | undefined): Record<string, unknown> | null {
  if (desc == null) return null;
  return {
    description: desc.description,
    keywords: desc.keywords ?? [],
    relatedOrigins: desc.relatedOrigins ?? [],
    relatedTags: desc.relatedTags ?? [],
  };
}

function normalizeTransition(t: TaskTransition | null | undefined): Record<string, unknown> | null {
  if (t == null) return null;
  return {
    type: t.type,
    similarity: t.similarity ?? null,
    previousTask: normalizeDescriptor(t.previousTask),
  };
}

function normalizeTransitionEntry(e: TransitionEntry): Record<string, unknown> {
  return {
    type: e.type,
    timestamp: e.timestamp,
    similarity: e.similarity ?? null,
    previousDescription: e.previousDescription ?? null,
    newDescription: e.newDescription ?? null,
  };
}

function normalizeTaskState(ts: TaskState): Record<string, unknown> {
  return {
    state: ts.state,
    currentTask: normalizeDescriptor(ts.currentTask),
    previousTask: normalizeDescriptor(ts.previousTask),
    taskSetAt: ts.taskSetAt ?? null,
    transitionCount: ts.transitionCount,
    changeCount: ts.changeCount,
    refinementCount: ts.refinementCount,
    reportsSinceSet: ts.reportsSinceSet,
    reportsSinceTransition: ts.reportsSinceTransition,
    lastTransition: normalizeTransition(ts.lastTransition),
    stale: ts.stale,
    gracePeriodActive: ts.gracePeriodActive,
    gracePeriodRemaining: ts.gracePeriodRemaining,
    transitionHistory: ts.transitionHistory.map(normalizeTransitionEntry),
  };
}

// Deep clone via structured clone or JSON round-trip
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── toJSON overloads ─────────────────────────────────────────────

export function qualityReportToJSON(report: QualityReport): Record<string, unknown> {
  const out = clone(report) as unknown as Record<string, unknown>;
  out['schemaVersion'] = SCHEMA_VERSION;
  return out;
}

export function diagnosticSnapshotToJSON(snapshot: DiagnosticSnapshot): Record<string, unknown> {
  const out = clone(snapshot) as unknown as Record<string, unknown>;
  out['schemaVersion'] = SCHEMA_VERSION;

  // Normalize task state (optional fields → null)
  out['taskState'] = normalizeTaskState(snapshot.taskState);

  // Normalize nested QualityReport if present
  if (snapshot.latestReport != null) {
    out['latestReport'] = qualityReportToJSON(snapshot.latestReport);
  }

  return out;
}

export function evictionPlanToJSON(plan: EvictionPlan): Record<string, unknown> {
  const out = clone(plan) as unknown as Record<string, unknown>;
  out['schemaVersion'] = SCHEMA_VERSION;
  return out;
}
