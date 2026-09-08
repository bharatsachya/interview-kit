/**
 * @trao/kernel — the zero-dependency implementations of the cross-cutting contracts.
 *
 * Tracer, Clock and IdGenerator. Everything here has a real second implementation, which is
 * the bar for existing at all: noop vs in-memory, system vs fixed, random vs sequential.
 */

export { SystemClock, FixedClock } from "./clock";
export { formatTrace } from "./format-trace";
export { SequentialIdGenerator, RandomIdGenerator, ScriptedIdGenerator } from "./ids";
export { RoutedIdGenerator } from "./routed-ids";
export { InMemoryTracer, NoopTracer } from "./tracer";
