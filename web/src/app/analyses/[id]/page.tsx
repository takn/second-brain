import { BookMarked } from "lucide-react";
import { notFound } from "next/navigation";
import { Narrative } from "@/components/narrative";
import { analysisById } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await analysisById(id);
  if (!analysis) notFound();

  return (
    <>
      <div className="project-header">
        <h1 className="page-title">{analysis.title}</h1>
        <span className="report-status report-status-published">
          <BookMarked size={11} strokeWidth={2} /> analysis
        </span>
      </div>
      <p className="page-subtitle">
        Saved by {analysis.savedByName ?? "unknown"} on{" "}
        {analysis.createdAt.toISOString().slice(0, 10)} · from the question “{analysis.question}”
      </p>

      <section className="card">
        <Narrative body={analysis.body} citations={analysis.citations} />
      </section>
    </>
  );
}
