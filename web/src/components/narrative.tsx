import Markdown from "react-markdown";
import type { CitedEvent } from "@/lib/queries";
import {
  linkCitations,
  prepareNarrative,
  splitNarrativeSections,
  type NarrativeChunk,
} from "@/lib/narrative-present";

/**
 * Narrative renderer with citation drill-down (task 5.3): inline
 * [event:<id>] markers become numbered links that jump to the cited event's
 * anchor in the timeline, where the source permalink lives.
 *
 * `variant="raw"` (default) renders the body unchanged aside from citations,
 * for reports, analyses, and other documents. Project detail passes
 * `sections` so each heading is a collapsible block (collapsed by default).
 * `excerpt` / `full` remain for older call sites.
 *
 * Pass `showCitations={false}` when the page renders {@link CitationList}
 * elsewhere (e.g. project detail Sources at the bottom).
 */
export function Narrative({
  body,
  citations,
  projectName = "",
  variant = "raw",
  showCitations = true,
}: {
  body: string;
  citations: CitedEvent[];
  projectName?: string;
  variant?: "raw" | "excerpt" | "full" | "sections";
  showCitations?: boolean;
}) {
  const prepared = variant === "raw" ? null : prepareNarrative(body, projectName);
  const source = prepared?.full ?? body;
  const order: string[] = [];
  const numberedFull = linkCitations(source, order);

  return (
    <div className="narrative">
      {variant === "excerpt" ? (
        <Excerpt chunks={prepared?.excerpt ?? []} order={order} />
      ) : variant === "sections" ? (
        <Sections markdown={source} order={order} />
      ) : (
        <Markdown>{numberedFull}</Markdown>
      )}
      {showCitations && variant !== "excerpt" && (
        <CitationList citations={citations} order={order} />
      )}
    </div>
  );
}

/** Numbered source list for cited events, in narrative appearance order. */
export function CitationList({
  body,
  citations,
  projectName = "",
  order: orderProp,
}: {
  /** When set, order is derived from the prepared narrative body. */
  body?: string;
  citations: CitedEvent[];
  projectName?: string;
  /** Precomputed citation ids in appearance order (skips body walk). */
  order?: string[];
}) {
  const order =
    orderProp ??
    (() => {
      if (!body) return [];
      const ids: string[] = [];
      linkCitations(prepareNarrative(body, projectName).full, ids);
      return ids;
    })();

  if (order.length === 0) return null;

  return (
    <ol className="citation-list">
      {order.map((id, i) => {
        const c = citations.find((x) => x.id === id);
        return (
          <li key={id} id={`cite-${id}`}>
            <a href={`#evt-${id}`}>
              [{i + 1}] {c?.title ?? "event"}
            </a>
            {c?.permalink && (
              <>
                {" · "}
                <a href={c.permalink}>source</a>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Project-detail Sources block at page bottom; omitted when nothing is cited. */
export function ProjectSources({
  body,
  citations,
  projectName = "",
}: {
  body: string;
  citations: CitedEvent[];
  projectName?: string;
}) {
  const order: string[] = [];
  linkCitations(prepareNarrative(body, projectName).full, order);
  if (order.length === 0) return null;
  return (
    <section className="project-sources">
      <h2>Sources</h2>
      <CitationList citations={citations} order={order} />
    </section>
  );
}

function Sections({ markdown, order }: { markdown: string; order: string[] }) {
  const sections = splitNarrativeSections(markdown);
  if (sections.length === 0) {
    return <div className="empty-note">No narrative synthesized yet.</div>;
  }
  // Seed order from the full body so footnote numbers match CitationList
  // even when sections render out of sync with a detached sources list.
  if (order.length === 0) linkCitations(markdown, order);
  return (
    <div className="narrative-sections">
      {sections.map((section, i) => (
        <details key={`${section.title}-${i}`} className="narrative-section">
          <summary>{section.title}</summary>
          {section.body ? (
            <Markdown>{linkCitations(section.body, order)}</Markdown>
          ) : (
            <div className="empty-note">No content in this section.</div>
          )}
        </details>
      ))}
    </div>
  );
}

function Excerpt({ chunks, order }: { chunks: NarrativeChunk[]; order: string[] }) {
  if (chunks.length === 0) {
    return <div className="empty-note">No highlight in the current narrative.</div>;
  }
  return (
    <>
      {chunks.map((chunk, i) =>
        chunk.kind === "markdown" ? (
          <Markdown key={i}>{linkCitations(chunk.text, order)}</Markdown>
        ) : (
          <div key={i}>
            <Markdown>{linkCitations(chunk.visible, order)}</Markdown>
            <details className="narrative-more">
              <summary>Show {chunk.hiddenCount} more</summary>
              <Markdown>{linkCitations(chunk.hidden, order)}</Markdown>
            </details>
          </div>
        ),
      )}
    </>
  );
}
