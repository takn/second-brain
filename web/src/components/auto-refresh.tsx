"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Poll-to-notify (task 5.7): while a question is pending, refresh the server
 * component tree so the answer appears as soon as the Query agent lands it.
 */
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
