import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

/**
 * Barlow Condensed 600 for titles and interface labels; Barlow 400/500 for everything read.
 * Two families, six roles, no exceptions — the weights are pinned here so a component cannot
 * quietly introduce a seventh.
 */
const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Interview Prep Kit",
  description: "A job description, a company, and the days you have left — turned into a study plan.",
};

/**
 * Clerk, wearing Industry.
 *
 * Set once here rather than per screen, so the sign-in form, the sign-up form and the user
 * button in the app cannot drift from each other. Only tokens the design system already defines
 * are passed through — this is a translation layer, not a second palette.
 */
const clerkAppearance = {
  variables: {
    colorPrimary: "#5980a6",
    colorText: "#1d1f20",
    colorTextSecondary: "#5c6063",
    colorBackground: "#ffffff",
    colorInputBackground: "#ffffff",
    colorInputText: "#1d1f20",
    colorDanger: "#ff0000",
    colorNeutral: "#1d1f20",
    fontFamily: "var(--font-barlow)",
    fontFamilyButtons: "var(--font-barlow)",
    borderRadius: "10px",
  },
  elements: {
    // Typography only. Surface treatment is scoped to the auth screens in `AuthSplit`, because
    // the `UserButton` popover inside the app genuinely does want to read as a raised card and
    // the sign-in form genuinely does not.
    headerTitle: "font-head font-semibold tracking-[0.01em]",
    headerSubtitle: "text-[14px]",
    formButtonPrimary: "font-head tracking-[0.04em] uppercase text-[13px]",
  },
} as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ClerkProvider appearance={clerkAppearance}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}