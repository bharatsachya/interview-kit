# 14 — API contract around the builder

Target: `apps/api` routes, run against the in-memory persistence adapter with a fake
Clerk verifier that accepts tokens `user-a` and `user-b`.

Assert per case: status code, and the listed body/side-effect properties.
