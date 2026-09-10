import { SignUp } from "@clerk/nextjs";
import { AuthSplit } from "@/components/auth/auth-split";

export default function SignUpPage() {
  return (
    <AuthSplit>
      <SignUp />
    </AuthSplit>
  );
}
