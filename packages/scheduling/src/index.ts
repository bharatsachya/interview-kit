/**
 * @trao/scheduling — day-by-day allocation. Pure, deterministic, no model anywhere near it.
 *
 * Repair is not here: it lives in @trao/kit, because repair must be minimal-disturbance rather
 * than a re-allocation, or it would wipe the days the user edited. See docs/DECISIONS.md.
 */

export { allocateSchedule, reallocateSchedule, type AllocationInput } from "./allocate";
export { EMPTY_DAY_FOCUS, MIXED_FOCUS, focusFor } from "./focus";
export { byUrgency, indexRequirements, priorityWeight, questionWeight } from "./weight";
