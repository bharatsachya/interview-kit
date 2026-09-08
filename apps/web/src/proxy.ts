import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Establishes the Clerk auth context for the request. It does not decide access.
 *
 * Route protection lives in `app/(signed-in)/layout.tsx` instead, because middleware
 * protection is path matching, and path matching can diverge from how Next actually routes a
 * request — which is Clerk's own reason for deprecating `createRouteMatcher`. A resource-based
 * check cannot drift from the resource: the layout that renders a kit is the layout that
 * requires a session.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
