import type { ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/app-shell";

/**
 * Everything inside this group requires a session. Signed-out visitors reach nothing.
 *
 * The group adds no path segment, so the URLs are unchanged — it exists so that the auth check
 * and the signed-in chrome are declared once, next to each other, and a page added here is
 * protected by virtue of where it lives rather than by remembering to add it to a list.
 *
 * This is not the ownership check. Whether *this* user may read *this* kit depends on the kit,
 * so that check belongs next to the load, not here.
 */
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  await auth.protect();
  return <AppShell>{children}</AppShell>;
}
