/**
 * @trao/pipeline — the nine steps, in order, each inside a span.
 *
 * The one package that imports every domain package, because sequencing them is its job. It
 * still constructs nothing: providers, stores and clocks arrive as arguments. Both entry points
 * — `scripts/dev.ts` and `scripts/evaluate.ts` — call this same function, so there is never a
 * parallel implementation to drift.
 */

export { hashSubmission } from "./hash";
export { generateKit, type GenerateKitInput, type PipelineDeps, type PipelineResult } from "./pipeline";
