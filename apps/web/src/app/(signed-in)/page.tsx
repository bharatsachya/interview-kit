import { Suspense } from "react";
import { Workspace } from "@/components/workspace/workspace";

/**
 * The whole app is one route.
 *
 * History, conversation and kit are regions of a single surface, not pages: navigating between
 * them would remount the shell and lose the panel's scroll position and the conversation so far.
 * What would have been routes are `?kit=` and `?jobs=` on this one.
 */
export default function WorkspacePage() {
  return (
    <Suspense fallback={null}>
      <Workspace />
    </Suspense>
  );
}
