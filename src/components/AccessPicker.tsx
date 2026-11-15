// What an AI app may do and where: read only or read and edit, in every workspace or only some. Used on the
// approval page an app sends you to, and when creating an access token in Settings → AI & apps.
import { Toggle } from "./ui";
import { WorkspaceIcon } from "./Workspaces";

export type Access = "write" | "read";
export interface WorkspaceChoice {
  id: string;
  name: string | null;
  icon: string | null;
}

export function AccessPicker(props: {
  access: Access;
  setAccess: (a: Access) => void;
  /** null: every workspace, including new ones. */
  picked: string[] | null;
  setPicked: (p: string[] | null) => void;
  workspaces: WorkspaceChoice[];
}) {
  const { access, setAccess, picked, setPicked, workspaces } = props;
  return (
    <div className="access-pick">
      <div className="access-field">
        <span className="set-label">What it can do</span>
        <div className="seg" role="radiogroup" aria-label="What it can do">
          {(
            [
              ["write", "Read and edit"],
              ["read", "Read only"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={access === k} className={access === k ? "active" : ""} onClick={() => setAccess(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="access-field">
        <span className="set-label">Workspaces</span>
        <div className="seg" role="radiogroup" aria-label="Which workspaces">
          <button type="button" role="radio" aria-checked={picked === null} className={picked === null ? "active" : ""} onClick={() => setPicked(null)}>
            All of mine
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={picked !== null}
            className={picked !== null ? "active" : ""}
            onClick={() => picked === null && setPicked(workspaces.length === 1 ? [workspaces[0].id] : [])}
          >
            Only some
          </button>
        </div>
        {picked === null ? (
          <p className="muted small">Every workspace you're in, and any you join or make later.</p>
        ) : (
          <div className="set-list access-ws">
            {workspaces.map((w) => (
              <label key={w.id} className="set-row ws-person">
                <WorkspaceIcon id={w.id} name={w.name} icon={w.icon} size={24} />
                <div className="set-row-main">
                  <span className="set-row-title">{w.name ?? "Untitled workspace"}</span>
                </div>
                <Toggle on={picked.includes(w.id)} onChange={(on) => setPicked(on ? [...picked, w.id] : picked.filter((x) => x !== w.id))} />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Read and edit · All workspaces", for the list of connections. */
export function accessSummary(access: Access, workspaces: string[] | null, names: Map<string, string>): string {
  const what = access === "write" ? "Read and edit" : "Read only";
  if (!workspaces) return `${what} · all workspaces`;
  const known = workspaces.map((id) => names.get(id)).filter(Boolean) as string[];
  if (known.length === 1) return `${what} · ${known[0]}`;
  return `${what} · ${known.length || workspaces.length} workspaces`;
}
