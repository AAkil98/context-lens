# context-lens

Context window quality monitor for LLM applications.

Everyone managing LLM context windows truncates blind. Token count is the only signal. But context has *quality* — and quality degrades in predictable, detectable ways long before the window fills up.

context-lens measures what token counting can't: coherence, density, relevance, and continuity.

## What it does

- **Segments** — model your context window as structured, trackable units of meaning
- **Quality scoring** — four dimensions (coherence, density, relevance, continuity) scored from structural signals, no LLM calls
- **Degradation detection** — five named patterns (saturation, erosion, fracture, gap, collapse) with severity levels and remediation hints
- **Custom patterns** — register domain-specific degradation patterns that plug into the same detection framework
- **Eviction advisory** — ranked recommendations for what to remove, with impact estimates and strategy awareness
- **Report schema** — standardized JSON Schema for all output types, consumable by any language or tool
- **Fleet monitoring** — aggregate quality across multiple instances for multi-agent setups
- **Observability export** — optional OpenTelemetry adapter for quality metrics and pattern events
- **Serialization** — snapshot and restore instance state for recovery, replay, and export

## Status

**Design phase complete.** 14 specs drafted (10 core + 4 enrichment), all amendments done, all open questions resolved. Next: design review. See `REVIEW.md`.

## License

Apache 2.0
