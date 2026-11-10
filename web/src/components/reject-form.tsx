import { X } from "lucide-react";
import { rejectEventAction, rejectRevisionAction } from "@/lib/actions";

/**
 * Reject affordance (task 5.4): disclosure + reason form posting to a server
 * action. Authorization is enforced server-side (POC / backup / L1); the
 * button renders for everyone so the rule lives in exactly one place.
 */
export function RejectForm({
  target,
  id,
  returnTo,
  label = "Reject",
}: {
  target: "event" | "revision";
  id: string;
  returnTo: string;
  label?: string;
}) {
  const action = target === "event" ? rejectEventAction : rejectRevisionAction;
  const idField = target === "event" ? "eventId" : "revisionId";
  return (
    <details className="reject-details">
      <summary className="reject-summary">
        <X size={13} strokeWidth={2} /> {label}
      </summary>
      <form action={action} className="reject-form">
        <input type="hidden" name={idField} value={id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input
          type="text"
          name="reason"
          placeholder="Why is this wrong? (required)"
          required
          className="reject-reason"
        />
        <button type="submit" className="btn-danger">
          Confirm reject
        </button>
      </form>
    </details>
  );
}

export function ErrorBanner({ message }: { message?: string | string[] }) {
  const text = Array.isArray(message) ? message[0] : message;
  if (!text) return null;
  return <div className="error-banner">{text}</div>;
}

/** Flash after one-click Jira create — key, board, and link to the issue. */
export function CreatedIssueBanner({
  created,
  board,
  url,
}: {
  created?: string;
  board?: string;
  url?: string;
}) {
  if (!created) return null;
  return (
    <div className="info-banner">
      Created <strong>{created}</strong>
      {board ? <> on the <strong>{board}</strong> board</> : null}
      {url ? (
        <>
          {" "}
          — <a href={url}>open in Jira</a>
        </>
      ) : null}
    </div>
  );
}
