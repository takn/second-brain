import { SearchBox } from "@/components/search-box";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return (
    <>
      <h1 className="page-title">Search</h1>
      <p className="page-subtitle">
        Full-text search across projects, people, events, and current narratives.
      </p>
      <SearchBox initialQuery={q ?? ""} />
    </>
  );
}
