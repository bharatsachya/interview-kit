import type { ReactNode } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/** Max page width 1180; the phone is the base layout and the laptop adds columns, not furniture. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-page flex-1 flex-col px-4 md:px-6">
      <header className="border-divider flex items-center gap-6 border-b py-4">
        <Link href="/" className="font-head text-lg tracking-tight">
          Interview Prep Kit
        </Link>
        <div className="ml-auto flex items-center gap-4">
          <UserButton />
        </div>
      </header>
      {children}
    </div>
  );
}
