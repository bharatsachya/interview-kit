import { SignUp } from "@clerk/nextjs";
import { AuthSplit } from "@/components/auth/auth-split";

/** See the note in the sign-in page: the pair is wired here, not left to configuration. */
export default function SignUpPage() {
  return (
    <AuthSplit>
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/" />
    </AuthSplit>
  );
}
