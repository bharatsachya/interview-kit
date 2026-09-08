import { getKitForBuilder, type BuilderKit } from "@trao/kit";
import { fixtureKit } from "@/lib/fixture-kit";

/**
 * The single seam between the UI and where kits come from.
 *
 * Today it returns a fixture; once the API is up it becomes a fetch. Everything above it reads
 * `getKitForBuilder` output — active items only, provenance flags intact, schedule repaired —
 * so no screen has to know which of the two it is looking at.
 */
export async function loadKit(kitId: string): Promise<BuilderKit | null> {
  const kit = fixtureKit();
  if (kit.id !== kitId) return null;
  return getKitForBuilder(kit);
}

export async function listKits(): Promise<{ id: string; title: string; company: string; days: number }[]> {
  const kit = fixtureKit();
  return [
    {
      id: kit.id,
      title: kit.role.title,
      company: kit.role.company,
      days: kit.schedule.daysAvailable,
    },
  ];
}
