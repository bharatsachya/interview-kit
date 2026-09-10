"use client";
/* TEMPORARY visual harness — deleted after screenshotting. Not part of the app. */
import { useState } from "react";
import type { Span } from "@trao/contracts";
import type { InternalKit } from "@trao/kit";
import { KitIndex } from "@/components/workspace/kit-index";
import { KitOutputBody, type Confidence, type ConfidenceMap } from "@/components/workspace/kit-outputs-body";
import { OutputGrid } from "@/components/workspace/output-grid";
import { Trace } from "@/components/workspace/trace";
import { Composer } from "@/components/workspace/composer";
import { KIT_OUTPUTS, type KitOutputId } from "@/lib/kit-outputs";

const q = (id: string, category: any, prompt: string, difficulty: any, reqs: string[], order: number) => ({
  id, category, prompt, answerOutline: "Name where the key is stored\nSay what it is scoped to\nExplain the retry path",
  difficulty, requirementIds: reqs, origin: "generated" as const, pinned: false, active: true, order,
});

const KIT: InternalKit = {
  id: "k1", createdAt: 0,
  role: { title: "Senior Backend Engineer, Payments", company: "Vaultline", location: "Remote, EU",
    summary: "Owns the ledger and settlement path end to end, on call for what it ships.",
    responsibilities: ["Build the settlement path", "Run the pager"] },
  companyBrief: {
    summary: "Vaultline runs ledger-and-settlement infrastructure for marketplaces that hold funds on behalf of sellers.",
    whatTheyDo: "The product is an API plus a reconciliation console; the ledger is the thing customers actually buy.",
    hiringProcess: "Four stages, with a ledger-modelling exercise in the middle that candidates report failing.",
    sources: ["https://vaultline.com/engineering/the-ledger", "https://vaultline.com/about"],
    pagesUsed: ["https://vaultline.com/engineering/the-ledger"],
    gaps: ["No public writing about compensation bands."], edited: false },
  requirements: [
    { id: "r1", text: "Distributed systems", kind: "technical", priority: "must" },
    { id: "r2", text: "Payments domain", kind: "domain", priority: "must" },
    { id: "r3", text: "Go or Java in production", kind: "technical", priority: "must" },
    { id: "r4", text: "Postgres at scale", kind: "technical", priority: "must" },
    { id: "r5", text: "Event-driven design", kind: "technical", priority: "must" },
    { id: "r6", text: "On-call ownership", kind: "behavioural", priority: "must" },
    { id: "r7", text: "Mentoring mid-engineers", kind: "behavioural", priority: "nice" },
  ],
  questions: [
    q("q1","technical","Walk me through modelling a double-entry ledger that survives a partial settlement failure.",3,["r2"],0),
    q("q2","technical","A consumer processes the same payout event twice. Where does the idempotency key live?",3,["r5"],1),
    q("q3","technical","Your reconciliation job holds a lock long enough to stall writes. Diagnose it.",2,["r4"],2),
    q("q4","behavioural","Describe a service you owned end to end — what did you carry the pager for?",2,["r6"],3),
    q("q5","system-design","Design streaming reconciliation for multi-currency settlement.",3,["r1"],4),
    q("q6","company-fit","What would you insist on getting right before the first EU payout?",2,["r2"],5),
  ],
  flashcards: [
    { id: "f1", front: "What guarantee does an idempotency key actually give you?", back: "Exactly-once effect, not exactly-once delivery. A duplicate short-circuits to the stored result of the first.", requirementIds: ["r5"], questionId: "q2", origin: "generated", pinned: false, active: true, order: 0 },
    { id: "f2", front: "What must hold true of every posted transaction?", back: "Debits equal credits inside the transaction, and the transaction is the atomic unit.", requirementIds: ["r2"], questionId: "q1", origin: "generated", pinned: false, active: true, order: 1 },
    { id: "f3", front: "What breaks first under a long reconciliation transaction?", back: "Autovacuum stalls behind the oldest snapshot; latency arrives before errors.", requirementIds: ["r4"], questionId: "q3", origin: "generated", pinned: false, active: true, order: 2 },
  ],
  schedule: { daysAvailable: 8, days: [
    { day: 1, focus: "Read the brief, then the ledger posts", questionIds: ["q1"], minutes: 45, edited: false },
    { day: 2, focus: "Double-entry modelling — hardest track first", questionIds: ["q1","q2"], minutes: 55, edited: false },
    { day: 3, focus: "Idempotency and exactly-once semantics", questionIds: ["q2"], minutes: 50, edited: false },
  ]},
  coverage: { passes: 2, uncoveredRequirementIds: ["r7"] },
};

const SPANS: Span[] = [
  { id: "s1", parentId: null, step: "extract_requirements", startedAt: 0, endedAt: 1200, durationMs: 1200, status: "ok", attrs: { requirements: 7, must_have: 6 } },
  { id: "s2", parentId: null, step: "crawl_site", startedAt: 0, endedAt: 3800, durationMs: 3800, status: "ok", attrs: { hiring_page: "vaultline.com/careers" } },
  { id: "s3", parentId: null, step: "generate_brief", startedAt: 0, endedAt: 2100, durationMs: 2100, status: "ok", attrs: {} },
  { id: "s4", parentId: null, step: "generate_questions.technical", startedAt: 0, endedAt: 4600, durationMs: 4600, status: "ok", attrs: { category: "technical", count: 3 } },
  { id: "s5", parentId: null, step: "search_discussion", startedAt: 0, endedAt: 300, durationMs: 300, status: "skipped", attrs: { reason: "No search key configured" } },
  { id: "s6", parentId: null, step: "allocate_schedule", startedAt: 0, endedAt: 1700, durationMs: 1700, status: "ok", attrs: { days: 8, minutes: 380 } },
];

export default function Preview() {
  const [output, setOutput] = useState<KitOutputId>("brief");
  const [confidence, setConfidence] = useState<ConfidenceMap>({ f2: "known", f3: "shaky" });
  const [track, setTrack] = useState<any>(null);
  const rate = (id: string, v: Confidence) => setConfidence((p) => ({ ...p, [id]: v }));

  return (
    <div className="flex h-dvh">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-8 py-6">
          <Trace spans={SPANS} defaultOpen />
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-[23px]">Interview kit for {KIT.role.company}</h2>
            <span className="text-ink/55 text-xs">{KIT.role.title} · 8 days out</span>
          </div>
          <OutputGrid kit={KIT} spans={SPANS} activeId={output} onOpen={setOutput} />
        </div>
        <div className="bg-tint px-8 py-4">
          <Composer variant="docked" onStarted={() => {}} />
        </div>
      </main>
      <aside className="bg-surface flex w-panel shrink-0">
        <KitIndex active={output} builtIn="13.7s" onSelect={setOutput} />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <KitOutputBody output={output} kit={KIT} confidence={confidence} onRate={rate}
            track={track} onTrack={setTrack} onOpenOutput={setOutput} />
        </div>
      </aside>
    </div>
  );
}
