# @trao/auth

Verifying a Clerk session token. That is the whole package.

Imports `@trao/contracts` and `jose`.

## Why Clerk, and why this is small

The brief says to keep auth minimal and does not score it, so the cheapest correct thing wins.
There are no roles, no refresh handling and no session store here, deliberately — see the
justification in the root README.

## The one thing that is not minimal

**The Express API verifies tokens itself against Clerk's JWKS.** It does not trust the Next.js
side to have done it. An API that believes a header because the frontend promises to set one is
not authenticated; it is authenticated only to people who use the frontend.

## Two failure codes, not one

`UNAUTHENTICATED` — there was nothing usable to check: no header, a foreign issuer, a bad
signature. The honest response is the sign-in page with no promise of coming back.

`SESSION_EXPIRED` — the credentials were ours and ran out. Send the user back to sign in and
return them to the page they were on.

Distinguishing them does leak that a token was well-formed and expired, which is not a secret
worth keeping: the client already holds the token and can read its own `exp`. Everything on the
other side of the line — bad signature, unknown key id, wrong issuer — collapses into the one
generic code, so probing with forged tokens teaches nothing about which half of the forgery
failed.

## Implementations

`ClerkAuthenticator` (real, JWKS-backed) and `DevAuthenticator` (`Bearer alice` is user
`alice`). The API refuses to start in production without `CLERK_ISSUER` and warns loudly when it
falls back to the dev one.

## What this package deliberately cannot reach

`pipeline` never imports it, and nothing here touches the domain. **Kit ownership is a field the
API layer attaches**, which is exactly what lets batch mode run with no user at all.
