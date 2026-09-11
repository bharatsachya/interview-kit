import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * @trao/auth — verifying a Clerk session token.
 *
 * The Express API verifies tokens itself against Clerk's JWKS rather than trusting the Next.js
 * side to have done it. An API that believes a header because the frontend promises to set one
 * is not authenticated; it is authenticated only to people who use the frontend.
 *
 * `pipeline` never imports this package, and nothing here reaches the domain. Kit ownership is a
 * field the API layer attaches — which is what lets batch mode run with no user at all.
 *
 * Auth is explicitly not scored beyond working, so this is deliberately the whole of it: no
 * roles, no refresh handling, no session store.
 */

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

/**
 * Why a request has no user.
 *
 * Two codes rather than one, because the UI has two different things to do. `SESSION_EXPIRED`
 * means the credentials were ours and simply ran out: send the user back to sign in and return
 * them to the page they were on. `UNAUTHENTICATED` means there was nothing usable to check at
 * all — no header, a foreign issuer, a bad signature — and the honest response is the sign-in
 * page with no promise of coming back.
 *
 * Distinguishing the two does leak that a token was well-formed and expired. That is not a
 * secret worth keeping: the client already holds the token and can read its own `exp`. What is
 * still withheld is everything on the other side of the line — a bad signature, an unknown key
 * id and a wrong issuer all collapse into the one generic code, so an attacker probing with
 * forged tokens learns nothing about which half of the forgery failed.
 */
export type AuthFailureCode = "UNAUTHENTICATED" | "SESSION_EXPIRED";

export class AuthError extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AuthError";
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

export interface Authenticator {
  /** Throws `AuthError` on a missing, expired or unusable token. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedUser>;
}

export interface ClerkAuthOptions {
  /** e.g. https://your-app.clerk.accounts.dev — the issuer the token must claim. */
  issuer: string;
  /** Defaults to `${issuer}/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Injected in tests so the suite never reaches the network. */
  verify?: (token: string) => Promise<JWTPayload>;
  /** Injected so an expiry check is testable without waiting. Defaults to `Date.now`. */
  now?: () => number;
}

export class ClerkAuthenticator implements Authenticator {
  readonly #verify: (token: string) => Promise<JWTPayload>;
  readonly #now: () => number;

  constructor(options: ClerkAuthOptions) {
    this.#now = options.now ?? (() => Date.now());

    if (options.verify !== undefined) {
      this.#verify = options.verify;
    } else {
      // The key set is fetched once and cached by `jose`, with its own rotation handling —
      // re-fetching per request would add a round trip to every call.
      const jwks = createRemoteJWKSet(new URL(options.jwksUrl ?? `${options.issuer}/.well-known/jwks.json`));
      this.#verify = async (token) => {
        const { payload } = await jwtVerify(token, jwks, { issuer: options.issuer });
        return payload;
      };
    }
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedUser> {
    const token = bearerToken(authorizationHeader);
    if (token === null) throw new AuthError("UNAUTHENTICATED", "No bearer token.");

    let payload: JWTPayload;
    try {
      payload = await this.#verify(token);
    } catch (error) {
      // `jose` rejects an expired token before we ever see a payload, so expiry has to be
      // recognised from the error. Everything else collapses into the generic code.
      if (isExpiry(error)) throw new AuthError("SESSION_EXPIRED", "The session has expired.", { cause: error });
      throw new AuthError("UNAUTHENTICATED", "Token could not be verified.", { cause: error });
    }

    // Checked again on the payload, because an injected verifier — the dev bypass, a test —
    // does not run `jose`'s clock. A verifier that hands back an expired claim set must not
    // produce a longer-lived session than the real one does.
    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null;
    if (exp !== null && exp <= this.#now()) throw new AuthError("SESSION_EXPIRED", "The session has expired.");

    const id = typeof payload.sub === "string" ? payload.sub : "";
    if (id === "") throw new AuthError("UNAUTHENTICATED", "Token has no subject.");

    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    return { id, email };
  }
}

/**
 * For local development and for the tests.
 *
 * Reads the user id straight from the header. Enabled only by an explicit environment variable,
 * and `apps/api` refuses to start with it on unless `NODE_ENV` is not production — an auth
 * bypass that could be switched on in production by a stray env var is not a bypass, it is a
 * vulnerability.
 */
export class DevAuthenticator implements Authenticator {
  constructor(private readonly fallbackUserId = "dev-user") {}

  async authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedUser> {
    const token = bearerToken(authorizationHeader);
    return { id: token ?? this.fallbackUserId, email: null };
  }
}

/** `jose` throws `JWTExpired` with `code: "ERR_JWT_EXPIRED"`; both are checked so neither alone matters. */
function isExpiry(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "JWTExpired" || (error as { code?: unknown }).code === "ERR_JWT_EXPIRED";
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}
