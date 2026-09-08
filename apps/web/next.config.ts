import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The kit types and their Zod schema are TypeScript source in packages/, resolved through the
  // tsconfig paths allowlist rather than through node_modules — no @trao package publishes a
  // `main` or `exports` field, by design, so the dependency rule cannot be routed around.
  // Next has to be told to compile that source, and where the workspace actually starts.
  transpilePackages: ["@trao/kit", "@trao/contracts"],
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  typedRoutes: true,
  // Next writes its own CLAUDE.md and AGENTS.md into the app on dev. This repo already has
  // project instructions at the root, and a nested one would quietly override them.
  agentRules: false,
};

export default nextConfig;
