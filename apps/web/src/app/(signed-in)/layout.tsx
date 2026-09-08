import type { ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";

/**
 * Everything inside this group requires a session. Signed-out visitors reach nothing.
 *
 * The group adds no path segment, so URLs are unchanged — it exists so that the auth check is
 * declared once and a page added here is protected by virtue of where it lives rather than by
 * remembering to add it to a list.
 *
 * There is no chrome here. The workspace owns all three regions and its own full-height layout;
 * a wrapper adding padding or a header would fight it.
 */
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  await auth.protect();
  return children;
}
