import { NextResponse } from "next/server";
import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getHealth();
  const allOk = health.db === "ok" && health.storage === "ok" && health.queue === "ok";
  return NextResponse.json(health, { status: allOk ? 200 : 503 });
}
