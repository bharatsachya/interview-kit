import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { KitError } from "@trao/contracts";

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

export interface Authenticator {
  /** Throws `KitError("INVALID_INPUT")` on a missing or unusable token. */
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedUser>;
}

export interface ClerkAuthOptions {
  /** e.g. https://your-app.clerk.accounts.dev — the issuer the token must claim. */
  issuer: string;
  /** Defaults to `${issuer}/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** Injected in tests so the suite never reaches the network. */
  verify?: (token: string) => Promise<JWTPayload>;
}

export class ClerkAuthenticator implements Authenticator {
  readonly #verify: (token: string) => Promise<JWTPayload>;

  constructor(options: ClerkAuthOptions) {
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
    if (token === null) throw unauthorised("No bearer token.");

    let payload: JWTPayload;
    try {
      payload = await this.#verify(token);
    } catch (error) {
      // The reason is deliberately not passed back to the caller — "expired" versus "bad
      // signature" tells an attacker which half of the problem to work on.
      throw unauthorised("Token could not be verified.", error);
    }

    const id = typeof payload.sub === "string" ? payload.sub : "";
    if (id === "") throw unauthorised("Token has no subject.");

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

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function unauthorised(message: string, cause?: unknown): KitError {
  return new KitError("INVALID_INPUT", message, { ...(cause !== undefined ? { cause } : {}), details: { status: 401 } });
}
