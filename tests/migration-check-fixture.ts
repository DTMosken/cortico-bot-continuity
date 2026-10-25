/** Scripted source-check responses exercise references; model semantics are tested separately. */
export const checkedSources = (sources: Record<string, string>, ids: string[]) => JSON.stringify({
  ready: true, issues: [], coverage: Object.entries(sources).map(([source, quote]) => ({ source, quote, constraintIds: ids })),
});
