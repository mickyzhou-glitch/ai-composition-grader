import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Deliberately minimal endpoint for local service supervision. */
export function GET() {
  return NextResponse.json({ ok: true, data: { status: "up" } }, {
    headers: { "cache-control": "no-store" },
  });
}
