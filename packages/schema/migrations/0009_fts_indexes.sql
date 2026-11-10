-- Fast search (web-app spec, task 5.6): expression GIN indexes so
-- websearch_to_tsquery lookups over events, narratives, projects, and people
-- stay fast without maintaining materialized tsvector columns.
CREATE INDEX IF NOT EXISTS "events_fts" ON "events" USING gin (
  to_tsvector('english', "title" || ' ' || coalesce("body", ''))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "narrative_revisions_fts" ON "narrative_revisions" USING gin (
  to_tsvector('english', coalesce("summary", '') || ' ' || "body")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_fts" ON "projects" USING gin (
  to_tsvector('english', "name" || ' ' || coalesce("description", ''))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_fts" ON "people" USING gin (
  to_tsvector('english', "display_name" || ' ' || coalesce("email", ''))
);
