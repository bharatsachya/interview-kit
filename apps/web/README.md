# apps/web

The Next.js interface. One route, three panes, no navigation.

## The whole app is one screen

`app/(signed-in)/page.tsx` mounts `<Workspace />` and that is the application: history on the
left, the conversation in the middle, the kit on the right.

**Selecting a kit or starting a run changes state here rather than navigating.** A navigation
would remount the shell, and remounting is what loses the panel's scroll position, the
conversation so far, and the animation you were in the middle of. There is no `router.push`, no
`window.open` and no `target="_blank"` anywhere in `components/workspace`.

The URL still carries `?kit=` and `?jobs=` so a run or a kit can be linked to, written with
`history.replaceState` rather than the router — the router would round-trip to the server to
re-render a page whose only job is to mount this component.

## The surfaces

| Component | Is |
|---|---|
| `workspace/composer.tsx` | the posting, the site, the days — and rewrite mode, where a staged prompt is edited and sent |
| `workspace/generation-stream.tsx` | one run as it happens, over the live span feed |
| `workspace/trace.tsx` | the span tree, the same component for a live run and a finished one |
| `workspace/kit-drawer.tsx` + `kit-outputs-body.tsx` | the builder: inline editing, reordering, pinning, adding, rewriting |
| `workspace/history-sidebar.tsx` | kits **and** runs, merged — see `lib/history.ts` |
| `workspace/compare-view.tsx` | more than one kit side by side |
| `workspace/ask-document.tsx` | the posting you sent, openable, because the composer clears on submit |

`components/industry/` is the design system — `Button`, `Badge`, `Frame`, `InlineEdit`,
`EmptyState`, `ErrorNotice`, `Skeleton`. `docs/design-system.html` is the reference sheet.

## Optimistic updates run the server's own functions

`apps/web` may import `@trao/kit`, so the local preview of an edit is `editQuestion` — the same
pure function the API calls. The usual objection to optimistic UI is that the client grows a
second, worse copy of the business rules that drifts; here there is no second copy. What the user
sees immediately is what the server will compute, and the response replaces it anyway.

`lib/use-builder.ts` holds that, plus the conflict handling: when a write is refused because
someone else moved the kit on, the *intent* is kept, so "reload and reapply" is a real offer
rather than a hopeful one.

## The API routes are a proxy, not a second API

`app/api/**` forwards to the Express API and validates nothing. The API parses every body with
zod and returns a typed 400; a second opinion in the proxy is a second thing to keep in step, and
the two disagreeing is worse than either being wrong alone.

The one thing the hop does do is rename the version guard: `X-Kit-Version` from the browser,
`If-Match` to the API. They mean the same thing, and only one of them is safe to send through a
CDN — Vercel's edge evaluates `If-Match` against the response's ETag and answers 412 for a write
that succeeded.

## History is runs, not kits

A kit does not exist until its job succeeds, so a list built from kits alone loses every failure
the moment the page reloads — which is the worst possible time to lose one. `lib/history.ts`
merges both lists: a kit carries what a finished run was *about*, a job carries the runs that have
no kit yet or never will.

## Tests

`test/` covers the pure logic — `history.ts`, `ask.ts`, `rewrite.ts`, `spans.ts`, `compare.ts`,
the version-guard header, and `kitName`. Components are not unit-tested; the API contract they
speak to is, in `apps/api/test/api.test.ts`.
