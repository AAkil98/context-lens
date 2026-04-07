/**
 * Formatters — pure functions for plain-text output of reports,
 * diagnostics, and patterns. No ANSI, no side effects.
 * @see cl-spec-010 §8
 */

import type {
  QualityReport,
  DiagnosticSnapshot,
  ActivePattern,
} from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────

const BASE_PATTERN_NAMES = new Set(['saturation', 'erosion', 'fracture', 'gap', 'collapse']);

function fmt2(n: number | null): string {
  return n !== null ? n.toFixed(2) : '-.--';
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDelta(d: number): string {
  if (Math.abs(d) < 0.005) return 'stable';
  return d > 0 ? `+${d.toFixed(2)}` : d.toFixed(2);
}

function fmtDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── formatReport ─────────────────────────────────────────────────

export function formatReport(report: QualityReport): string {
  const lines: string[] = [];

  // Line 1: Header
  lines.push(`Report ${report.reportId}  ${isoTimestamp(report.timestamp)}`);

  // Line 2: Scores
  const ws = report.windowScores;
  lines.push(
    `  Coherence: ${fmt2(ws.coherence)}  Density: ${fmt2(ws.density)}  ` +
    `Relevance: ${fmt2(ws.relevance)}  Continuity: ${fmt2(ws.continuity)}  ` +
    `Composite: ${fmt2(report.composite)}`,
  );

  // Line 3: Capacity
  const cap = report.capacity;
  lines.push(
    `  Utilization: ${fmtPct(cap.utilization)} ` +
    `(${fmtTokens(cap.totalActiveTokens)}/${fmtTokens(cap.capacity)} tokens)  ` +
    `Segments: ${report.segmentCount}  Headroom: ${fmtTokens(cap.headroom)}`,
  );

  // Active patterns
  const patterns = report.patterns;
  if (patterns.patternCount > 0) {
    lines.push('  Patterns:');
    for (const p of patterns.patterns) {
      lines.push(`    [${p.severity.toUpperCase()}] ${p.name}: ${p.explanation}`);
    }
  }

  // Trends
  if (report.trend !== null) {
    const t = report.trend;
    lines.push(
      `  Trend: coherence ${fmtDelta(t.coherenceDelta)}  density ${fmtDelta(t.densityDelta)}  ` +
      `relevance ${fmtDelta(t.relevanceDelta)}  continuity ${fmtDelta(t.continuityDelta)}`,
    );
  }

  // Notes: compound context, grace period
  for (const p of patterns.patterns) {
    if (p.compoundContext !== null) {
      lines.push(`  Note: ${p.compoundContext.compound} — ${p.compoundContext.diagnosis}`);
      break; // One compound note is sufficient
    }
  }
  if (report.task.gracePeriodActive) {
    lines.push(`  Note: Task grace period active (${report.task.gracePeriodRemaining} reports remaining)`);
  }
  if (report.baseline === null && report.segmentCount > 0) {
    lines.push('  Note: Pre-baseline (scores are raw, not normalized)');
  }

  return lines.join('\n');
}

// ─── formatDiagnostics ────────────────────────────────────────────

export function formatDiagnostics(snapshot: DiagnosticSnapshot): string {
  const lines: string[] = [];

  // Latest report or placeholder
  if (snapshot.latestReport !== null) {
    lines.push(formatReport(snapshot.latestReport));
  } else {
    lines.push('No reports generated yet.');
  }

  lines.push('');

  // Session overview
  lines.push(`Session: ${fmtDuration(snapshot.sessionDuration)}`);

  const reportCount = snapshot.reportHistory.reports.length;
  const mutationTypes = ['segmentAdded', 'segmentUpdated', 'segmentReplaced', 'segmentCompacted', 'segmentSplit', 'segmentEvicted', 'segmentRestored'];
  const mutationCount = snapshot.timeline.filter(e => mutationTypes.includes(e.type)).length;
  lines.push(`  Reports: ${reportCount}  Mutations: ${mutationCount}  Segments: ${snapshot.segmentCount} active, ${snapshot.evictedCount} evicted`);

  // Pattern history
  const ps = snapshot.patternSummary;
  lines.push(`  Patterns: ${ps.totalActivations} activations, ${ps.totalResolutions} resolutions, ${ps.activePatterns.length} active`);
  for (const [name, stats] of Object.entries(ps.perPattern)) {
    if (stats.recurrenceCount > 1) {
      lines.push(`    Warning: ${name} has recurred ${stats.recurrenceCount} times`);
    }
  }

  // Performance
  const perf = snapshot.performance;
  const ops = perf.operationTimings;
  const hotOps = ['add', 'assess', 'planEviction'];
  const hasPerf = hotOps.some(op => ops[op] !== undefined);
  if (hasPerf) {
    lines.push('  Performance:');
    for (const op of hotOps) {
      const s = ops[op];
      if (s !== undefined) {
        lines.push(`    ${op}: avg ${s.averageSelfTime.toFixed(2)}ms, max ${s.maxSelfTime.toFixed(2)}ms (${s.count} calls)`);
      }
    }
    if (perf.budgetViolationCount > 0) {
      lines.push(`    Budget violations: ${perf.budgetViolationCount}`);
    }
  }

  // Provider state
  lines.push(`  Tokenizer: ${snapshot.providers.tokenizer.name} (${snapshot.providers.tokenizer.accuracy})`);
  if (snapshot.providers.embedding !== null) {
    lines.push(`  Embedding: ${snapshot.providers.embedding.name} (${snapshot.providers.embedding.dimensions}d)`);
  } else {
    lines.push('  Embedding: trigram mode');
  }

  // Warnings
  if (snapshot.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of snapshot.warnings) {
      lines.push(`    [${w.code}] ${w.message}`);
    }
  } else {
    lines.push('  No warnings.');
  }

  return lines.join('\n');
}

// ─── formatPattern ────────────────────────────────────────────────

export function formatPattern(pattern: ActivePattern): string {
  const isCustom = !BASE_PATTERN_NAMES.has(pattern.name);
  const namePrefix = isCustom ? 'Custom: ' : '';
  const sev = `[${pattern.severity.toUpperCase()}]`;

  const parts: string[] = [];
  parts.push(`${sev} ${namePrefix}${pattern.name}`);
  parts.push(pattern.explanation);

  if (pattern.remediation.length > 0) {
    const top = pattern.remediation[0]!;
    parts.push(`Suggestion: ${top.description}`);
  }

  return parts.join(' — ');
}
