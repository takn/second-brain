"use client";

import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@/lib/queries";

const KIND_LABEL: Record<string, string> = {
  project: "Project",
  person: "Person",
  event: "Event",
  narrative: "Narrative",
  analysis: "Saved analysis",
};

/** Debounced as-you-type search against /api/search (task 5.6). */
export function SearchBox({ initialQuery = "" }: { initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    if (q.trim().length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { hits: SearchHit[] };
        setHits(data.hits);
        setLoading(false);
      } catch {
        // aborted or transient; keep prior results
      }
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q]);

  const groups = new Map<string, SearchHit[]>();
  for (const h of hits) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);

  return (
    <div className="search-page">
      <div className="search-wrap">
        <Search size={18} strokeWidth={1.75} className="search-icon" />
        <input
          autoFocus
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects, people, events, narratives, analyses…"
          className="search-input search-input-lg"
        />
      </div>
      {loading && <div className="empty-note">Searching…</div>}
      {!loading && q.trim().length >= 2 && hits.length === 0 && (
        <div className="empty-note">No matches for “{q}”.</div>
      )}
      {[...groups.entries()].map(([kind, groupHits]) => (
        <section key={kind} className="card search-group">
          <h2>{KIND_LABEL[kind] ?? kind}</h2>
          <ul className="event-list">
            {groupHits.map((h) => (
              <li key={h.id} className="event-item">
                {h.href ? <a href={h.href}>{h.title}</a> : <span>{h.title}</span>}
                {h.snippet && <div className="event-body">{h.snippet}</div>}
                {h.meta && (
                  <div className="event-meta">
                    <span>{h.meta}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
