import { CreateConversation } from "@/components/create/conversation";
import { Eyebrow } from "@/components/industry/text";

export default function CreatePage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-10 pt-16 pb-6">
      <header className="flex flex-col gap-3">
        <Eyebrow className="text-teal-700">
          <h1 className="inline">New kit</h1>
        </Eyebrow>
      </header>
      <CreateConversation />
    </main>
  );
}
