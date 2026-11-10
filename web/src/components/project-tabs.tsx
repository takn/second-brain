"use client";

import { type ReactNode, useState } from "react";

export type ProjectTabId =
  | "progress"
  | "decisions"
  | "blockers"
  | "dependencies"
  | "health";

const TABS: { id: ProjectTabId; label: string }[] = [
  { id: "progress", label: "Progress" },
  { id: "decisions", label: "Decisions" },
  { id: "blockers", label: "Blockers" },
  { id: "dependencies", label: "Dependencies" },
  { id: "health", label: "Health Signals" },
];

/**
 * Project detail secondary panels. All panels stay in the DOM (hidden when
 * inactive) so narrative citation anchors (#evt-…) still resolve.
 */
export function ProjectTabs({
  counts,
  panels,
}: {
  counts: Record<ProjectTabId, number>;
  panels: Record<ProjectTabId, ReactNode>;
}) {
  const [active, setActive] = useState<ProjectTabId>("progress");

  return (
    <div className="project-tabs">
      <div className="project-tablist" role="tablist" aria-label="Project detail">
        {TABS.map((tab) => {
          const selected = active === tab.id;
          const count = counts[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              className={`project-tab${selected ? " is-active" : ""}`}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
              {count > 0 && <span className="project-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>
      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          className="project-tabpanel"
          hidden={active !== tab.id}
        >
          {panels[tab.id]}
        </div>
      ))}
    </div>
  );
}
