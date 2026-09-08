import Link from "next/link";
import { Frame } from "@/components/industry/frame";
import { Eyebrow } from "@/components/industry/text";
import { listKits } from "@/lib/kits";

export default async function HomePage() {
  const kits = await listKits();

  return (
      <main className="flex flex-col gap-6 py-16">
        <div className="flex flex-wrap items-center gap-6">
          <Eyebrow className="text-teal-700">
            <h1 className="inline">Your kits</h1>
          </Eyebrow>
          <Link
            href="/create"
            className="font-head rounded-control border-teal-700 bg-teal-700 text-paper ml-auto inline-flex min-h-11 items-center border px-4 text-sm tracking-wide md:min-h-9"
          >
            New kit
          </Link>
        </div>

        {kits.length === 0 ? (
          <Frame empty className="p-4" marks={false}>
            <p className="max-w-read text-sm">
              Nothing here yet. Paste a job description and a company site and we&rsquo;ll build one.
            </p>
          </Frame>
        ) : (
          <ul className="flex list-none flex-col gap-6">
            {kits.map((kit) => (
              <li key={kit.id}>
                <Frame className="p-4">
                  <Link href={`/kit/${kit.id}`} className="flex flex-wrap items-baseline gap-3">
                    <span className="text-2xl leading-tight font-head">{kit.title}</span>
                    <span className="text-sm opacity-70">{kit.company}</span>
                    <span className="ml-auto text-xs font-medium tabular-nums opacity-55">
                      {kit.days} DAYS
                    </span>
                  </Link>
                </Frame>
              </li>
            ))}
          </ul>
        )}
      </main>
  );
}
