import { assignOwnershipAction } from "@/lib/actions";

export interface PersonOption {
  id: string;
  displayName: string;
  email: string | null;
}

/**
 * L1-only editors for primary / backup POC on a project (project-ownership).
 * Non-L1 callers should render the read-only subtitle instead.
 */
export function OwnershipForm({
  projectId,
  returnTo,
  pocId,
  backupPocId,
  people,
}: {
  projectId: string;
  returnTo: string;
  pocId: string | null;
  backupPocId: string | null;
  people: PersonOption[];
}) {
  return (
    <form action={assignOwnershipAction} className="ownership-form">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <label className="ownership-field">
        <span>POC</span>
        <select name="pocId" defaultValue={pocId ?? ""}>
          <option value="">unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
              {p.email ? ` (${p.email})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="ownership-field">
        <span>Backup</span>
        <select name="backupPocId" defaultValue={backupPocId ?? ""}>
          <option value="">unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
              {p.email ? ` (${p.email})` : ""}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-small">
        Save ownership
      </button>
      {people.length === 0 && (
        <span className="ownership-empty">No active people — run GitLab seed/sync first.</span>
      )}
    </form>
  );
}

export function OwnershipReadOnly({
  pocName,
  backupPocName,
}: {
  pocName: string | null;
  backupPocName: string | null;
}) {
  return (
    <span className={pocName ? undefined : "ownership-unassigned"}>
      POC: {pocName ?? "unassigned"}
      {backupPocName ? <> (backup: {backupPocName})</> : null}
    </span>
  );
}
