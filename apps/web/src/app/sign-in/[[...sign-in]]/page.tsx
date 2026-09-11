import { SignIn } from "@clerk/nextjs";
import { AuthSplit } from "@/components/auth/auth-split";

/**
 * `signUpUrl` is given here rather than left to configuration.
 *
 * Without it Clerk points "Don't have an account?" at its hosted portal, which is a different
 * origin, styled differently, and reached only if the environment happens to carry
 * NEXT_PUBLIC_CLERK_SIGN_UP_URL. A deployment that forgot the variable therefore had a sign-in
 * page with no working way for a new person to create an account — the one journey that has to
 * work for someone who has never been here before. The two pages know about each other now.
 */
export default function SignInPage() {
  return (
    <AuthSplit>
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </AuthSplit>
  );
}
