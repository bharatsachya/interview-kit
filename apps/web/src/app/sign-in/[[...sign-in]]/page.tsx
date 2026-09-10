import { SignIn } from "@clerk/nextjs";
import { AuthSplit } from "@/components/auth/auth-split";

export default function SignInPage() {
  return (
    <AuthSplit>
      <SignIn />
    </AuthSplit>
  );
}
