import { NextResponse } from "next/server";
import { searchAll } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** As-you-type backend (task 5.6). Sits behind the SSO gate like every route. */
export async function GET(request: Request): Promise<NextResponse> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ hits: [] });
  const hits = await searchAll(q);
  return NextResponse.json({ hits });
}
