// Workspaces: the switcher in the sidebar, the "New workspace" dialog, and the workspace part of Settings.
// A workspace with only you in it is private: nobody else can open it, the owner of Sandpiper included.
import { useEffect, useState } from "react";
import { Check, Lock, LogOut, Plus, Settings, Trash2, Users, X } from "lucide-react";
import { api } from "../api";
import { openWorkspace, WS_ID } from "../nav";
import {
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
  setWorkspaceMembers,
  updateWorkspace,
  useCurrentWorkspace,
  useMe,
  useWorkspaceName,
  useWorkspaces,
  type WorkspaceMember,
} from "../store";
import { Avatar, Dropdown, EmojiPicker, MenuItem, MenuSep, Modal, Toggle } from "./ui";
import { LogoGlyph } from "./Logo";

/** Someone who can sign in to Sandpiper (Settings → People). */
interface Person {
  email: string;
  role: "owner" | "member";
  user: { id: string; name: string; color: string; avatar: string | null } | null;
}

function usePeople(): Person[] | null {
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    api("/api/members")
      .then((d) => setPeople(d.members))
      .catch(() => setPeople([]));
  }, []);
  return people;
}

const firstName = (m: { email: string; user: { name: string } | null }) => (m.user?.name ?? m.email.split("@")[0]).split(" ")[0];

/** "Only you", "You and Sam", "You, Sam and Asha". */
export function whoIsIn(members: WorkspaceMember[], myEmail: string): string {
  const others = members.filter((m) => m.email !== myEmail).map(firstName);
  if (!others.length) return "Only you";
  if (others.length === 1) return `You and ${others[0]}`;
  return `You, ${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
}

export function WorkspaceIcon({ id, name, icon, size = 22 }: { id: string; name: string | null; icon: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.62) };
  if (icon) return <span className="ws-logo emoji" style={style}>{icon}</span>;
  if (id === "main") return <span className="ws-logo brand" style={style}><LogoGlyph small /></span>;
  return (
    <span className="ws-logo letter" style={{ ...style, fontSize: Math.round(size * 0.5) }}>
      {(name?.trim()[0] ?? "W").toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------- switcher

/** The workspace button at the top of the sidebar, with the list of workspaces under it. */
export function WorkspaceSwitcher({ onSettings }: { onSettings: (tab: "workspace") => void }) {
  const me = useMe();
  const list = useWorkspaces();
  const current = useWorkspaceName();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Dropdown
        width={300}
        trigger={(open) => (
          <button className="ws-btn" onClick={open} title="Switch workspace" aria-haspopup="menu">
            <WorkspaceIcon id={WS_ID} name={current.name} icon={current.icon} />
            <span className="ws-name">{current.name}</span>
            <svg className="ws-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      >
        {(close) => (
          <div className="menu ws-menu">
            {me && <div className="menu-heading ws-menu-email">{me.email}</div>}
            {list.map((w) => {
              const here = w.id === WS_ID;
              const name = here ? current.name : (w.name ?? "Untitled workspace");
              const solo = w.members.length <= 1;
              return (
                <button
                  key={w.id}
                  type="button"
                  className={"ws-option" + (here ? " active" : "")}
                  onClick={() => (here ? close() : openWorkspace(w.id))}
                >
                  <WorkspaceIcon id={w.id} name={name} icon={here ? current.icon : w.icon} size={28} />
                  <span className="ws-option-main">
                    <span className="ws-option-name">{name}</span>
                    <span className="ws-option-sub">
                      {solo ? <Lock size={11} /> : <Users size={11} />}
                      {me ? whoIsIn(w.members, me.email) : ""}
                    </span>
                  </span>
                  {here && <Check size={15} className="ws-option-check" />}
                </button>
              );
            })}
            <MenuSep />
            <MenuItem icon={<Plus size={15} />} label="New workspace" onClick={() => (close(), setCreating(true))} />
            <MenuItem icon={<Settings size={15} />} label="Workspace settings" onClick={() => (close(), onSettings("workspace"))} />
          </div>
        )}
      </Dropdown>
      {creating && <NewWorkspaceModal onClose={() => setCreating(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- new workspace

export function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const me = useMe()!;
  const people = usePeople();
  const others = (people ?? []).filter((p) => p.email !== me.email);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shared = others.filter((p) => picked.includes(p.email));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const ws = await createWorkspace({ name: name.trim(), icon, members: picked });
      openWorkspace(ws.id);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="ws-modal">
      <form onSubmit={create}>
        <div className="panel-head">
          <span>New workspace</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="ws-modal-body">
          <div className="ws-name-row">
            <Dropdown
              width={340}
              trigger={(open) => (
                <button type="button" className="ws-icon-pick" onClick={open} title="Choose an icon" aria-label="Choose an icon">
                  <WorkspaceIcon id="new" name={name || "W"} icon={icon} size={36} />
                </button>
              )}
            >
              {(close) => (
                <EmojiPicker
                  onPick={(e) => (setIcon(e), close())}
                  onRemove={icon ? () => (setIcon(null), close()) : undefined}
                />
              )}
            </Dropdown>
            <input
              autoFocus
              aria-label="Workspace name"
              placeholder="Name it: Trips, Home, Work…"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <span className="set-label">Who's in it</span>
          <div className="set-list">
            <div className="set-row">
              <Avatar user={me} size={28} />
              <div className="set-row-main">
                <span className="set-row-title">
                  {me.name} <span className="muted">(you)</span>
                </span>
                <span className="muted small">Manages this workspace</span>
              </div>
            </div>
            {others.map((p) => (
              <label key={p.email} className="set-row ws-person">
                {p.user ? <Avatar user={p.user} size={28} /> : <span className="avatar avatar-empty" style={{ width: 28, height: 28 }} />}
                <div className="set-row-main">
                  <span className="set-row-title">{p.user?.name ?? p.email}</span>
                  <span className="muted small">{p.user ? p.email : "Hasn't signed in yet"}</span>
                </div>
                <Toggle
                  on={picked.includes(p.email)}
                  onChange={(on) => setPicked((cur) => (on ? [...cur, p.email] : cur.filter((x) => x !== p.email)))}
                />
              </label>
            ))}
            {people === null && <div className="muted small set-empty">Loading people…</div>}
          </div>
          <p className="ws-privacy">
            {shared.length ? <Users size={14} /> : <Lock size={14} />}
            {shared.length
              ? `Shared with ${shared.map(firstName).join(" and ")}. Nobody else can open it.`
              : "Private. Only you can open this workspace."}
          </p>
          {error && <p className="set-error">{error}</p>}
        </div>
        <div className="ws-modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings

/** Workspace settings → General: name and icon, then leaving or deleting it. */
export function WorkspaceGeneral() {
  const ws = useCurrentWorkspace();
  const shown = useWorkspaceName();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  if (!ws) return null;

  const manager = ws.isOwner;
  const managerName = ws.members.find((m) => m.email === ws.owner);
  const fail = (e: any) => setError(e?.message || "Something went wrong. Try again.");
  const save = (patch: { name?: string; icon?: string | null }) => updateWorkspace(ws.id, patch).catch(fail);

  const deleteForm = (
    <form
      className="ws-danger"
      onSubmit={async (e) => {
        e.preventDefault();
        if (typed.trim() !== shown.name.trim() || busy) return;
        setBusy(true);
        await deleteWorkspace(ws.id).catch((err) => (fail(err), setBusy(false)));
      }}
    >
      <span className="set-hint">
        This deletes every page in "{shown.name}"{ws.members.length > 1 ? " for everyone in it" : ""}. It can't be undone. Type the workspace's
        name to confirm:
      </span>
      <div className="set-rename-row">
        <input autoFocus aria-label="Workspace name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={shown.name} />
        <button className="btn danger small" disabled={typed.trim() !== shown.name.trim() || busy}>
          {busy ? "Deleting…" : "Delete workspace"}
        </button>
        <button type="button" className="btn-ghost small" onClick={() => (setConfirming(false), setTyped(""))}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <>
      <section className="set-section">
        <span className="set-label">Name and icon</span>
        <div className="ws-name-row">
          <Dropdown
            width={340}
            trigger={(open) => (
              <button type="button" className="ws-icon-pick" onClick={open} title="Change icon" aria-label="Change workspace icon">
                <WorkspaceIcon id={ws.id} name={shown.name} icon={shown.icon} size={36} />
              </button>
            )}
          >
            {(close) => (
              <EmojiPicker onPick={(e) => (save({ icon: e }), close())} onRemove={shown.icon ? () => (save({ icon: null }), close()) : undefined} />
            )}
          </Dropdown>
          <input
            key={shown.name}
            aria-label="Workspace name"
            defaultValue={shown.name}
            maxLength={60}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== shown.name) save({ name: v });
              else e.target.value = shown.name;
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </div>
      </section>

      {manager ? (
        <section className="set-section">
          <h3>Delete workspace</h3>
          {confirming ? (
            deleteForm
          ) : (
            <button className="btn-ghost ws-danger-btn" onClick={() => setConfirming(true)}>
              <Trash2 size={15} /> Delete this workspace…
            </button>
          )}
        </section>
      ) : (
        <section className="set-section">
          <h3>Leave workspace</h3>
          <p className="muted small">
            {managerName ? `${firstName(managerName)} manages this workspace.` : "Someone else manages this workspace."} If you leave, you can only come
            back if they add you again.
          </p>
          <button
            className="btn-ghost ws-danger-btn"
            onClick={() => confirm(`Leave "${shown.name}"? You won't be able to open it unless you're added back.`) && leaveWorkspace(ws.id).catch(fail)}
          >
            <LogOut size={15} /> Leave this workspace
          </button>
        </section>
      )}
      {error && <p className="set-error">{error}</p>}
    </>
  );
}

/** Workspace settings → Members: who can open this workspace. Only whoever manages it can change that. */
export function WorkspaceMembers() {
  const me = useMe()!;
  const ws = useCurrentWorkspace();
  const shown = useWorkspaceName();
  const people = usePeople();
  const [error, setError] = useState("");
  if (!ws) return null;

  const manager = ws.isOwner;
  const managerName = ws.members.find((m) => m.email === ws.owner);
  const inIt = new Set(ws.members.map((m) => m.email));
  const toggle = (p: Person, on: boolean) => {
    if (!on && !confirm(`Take ${p.user?.name ?? p.email} out of "${shown.name}"? They'll lose access straight away.`)) return;
    const next = on ? [...inIt, p.email] : [...inIt].filter((e) => e !== p.email);
    setError("");
    setWorkspaceMembers(ws.id, next).catch((e) => setError(e?.message || "Something went wrong. Try again."));
  };
  // Whoever manages it sees everyone who could be added; everyone else sees who's in it.
  const rows: Person[] = manager
    ? (people ?? []).slice().sort((a, b) => (a.email === me.email ? -1 : b.email === me.email ? 1 : 0))
    : ws.members.map((m) => ({ email: m.email, role: "member", user: m.user }));

  return (
    <section className="set-section">
      <p className="ws-privacy">
        {ws.members.length <= 1 ? <Lock size={14} /> : <Users size={14} />}
        {ws.members.length <= 1
          ? "Private. Only you can open this workspace."
          : manager
            ? "Only the people switched on can open this workspace."
            : `Only the people listed can open this workspace. ${managerName ? firstName(managerName) : "Whoever manages it"} decides who's in it.`}
      </p>
      <div className="set-list">
        {rows.map((p) => {
          const self = p.email === me.email;
          const isManager = p.email === ws.owner;
          return (
            <div key={p.email} className="set-row">
              {p.user ? <Avatar user={p.user} size={28} /> : <span className="avatar avatar-empty" style={{ width: 28, height: 28 }} />}
              <div className="set-row-main">
                <span className="set-row-title">
                  {p.user?.name ?? p.email}
                  {self && <span className="muted"> (you)</span>}
                  {isManager && <span className="badge">Manages it</span>}
                </span>
                <span className="muted small">{p.user ? p.email : "Hasn't signed in yet"}</span>
              </div>
              {manager && !isManager && <Toggle on={inIt.has(p.email)} onChange={(on) => toggle(p, on)} />}
            </div>
          );
        })}
        {manager && people === null && <div className="muted small set-empty">Loading people…</div>}
      </div>
      {error && <p className="set-error">{error}</p>}
    </section>
  );
}
