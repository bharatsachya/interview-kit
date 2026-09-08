import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getKitForBuilder } from "@trao/kit";
import { getKit } from "@/lib/mock/pipeline";

/**
 * GET /api/kits/:id — what the kit view and the builder read.
 *
 * Always the builder projection: active items only, provenance flags intact, schedule
 * repaired. Archived items never leave the server, so no client can render one by accident.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  await auth.protect();

  const { kitId } = await params;
  const kit = getKit(kitId);
  if (!kit) {
    return NextResponse.json({ code: "KIT_NOT_FOUND", message: `No kit ${kitId}.` }, { status: 404 });
  }

  return NextResponse.json({ kit: getKitForBuilder(kit) }, { headers: { "cache-control": "no-store" } });
}
