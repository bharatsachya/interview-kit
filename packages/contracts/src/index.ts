/**
 * @trao/contracts — interfaces and shared types. Imports nothing, ever.
 *
 * Every package depends on this one and on nothing else horizontally. Packages receive their
 * dependencies as arguments; only apps/api/main.ts, scripts/evaluate.ts and scripts/dev.ts
 * construct adapters. The per-package tsconfig.json files enforce it at compile time.
 */

export * from "./budget";
export * from "./cache";
export * from "./errors";
export * from "./llm";
export * from "./persistence";
export * from "./prompt";
export * from "./retrieval";
export * from "./time";
export * from "./tracing";
