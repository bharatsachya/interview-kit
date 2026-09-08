import Link from "next/link";
import { JobProgress } from "@/components/generating/job-progress";
import { EmptyState } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";

/**
 * The job ids live in the URL rather than in memory, which is what makes this page shareable
 * and what lets a closed tab be reopened onto a run already in flight.
 */
export default async function GeneratingPage({ searchParams }: PageProps<"/generating">) {
  const { jobs } = await searchParams;
  const raw = Array.isArray(jobs) ? jobs.join(",") : (jobs ?? "");
  const jobIds = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return (
    <main className="flex flex-col gap-10 py-16">
      <header className="flex flex-col gap-3">
        <Eyebrow className="text-teal-700">
          <h1 className="inline">{jobIds.length > 1 ? `Building ${jobIds.length} kits` : "Building your kit"}</h1>
        </Eyebrow>
      </header>

      {jobIds.length === 0 ? (
        <EmptyState
          title="Nothing to watch"
          actions={
            <Link href="/create" className="text-teal-700 text-sm underline underline-offset-4">
              Start a kit
            </Link>
          }
        >
          This link carries no job id, so there is no run to follow.
        </EmptyState>
      ) : (
        <JobProgress jobIds={jobIds} />
      )}
    </main>
  );
}
