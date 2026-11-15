// Settings, in three clearly separate groups:
//   Your account    profile, how you sign in (passkeys, devices), AI apps connected as you, appearance on this device
//   This workspace  its name and icon, who's in it, leaving or deleting it
//   Sandpiper        who can sign in at all (only the owner sees this)
import { ReactNode, useEffect, useState } from "react";
import { KeyRound, LogOut, Monitor, Moon, Pencil, Plug, Plus, ShieldCheck, SlidersHorizontal, Sun, SunMoon, Trash2, User, Users, X } from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { api, deviceName } from "../api";
import { signOut, updateProfile, USER_COLORS, useMe, useWorkspaceName } from "../store";
import { WS_ID } from "../nav";
import { Avatar, Modal, relTime } from "./ui";
import { WorkspaceGeneral, WorkspaceIcon, WorkspaceMembers } from "./Workspaces";
import { ConnectionsSection } from "./Connections";

export type ThemePref = "system" | "light" | "dark";
export type SettingsTab = "profile" | "security" | "ai" | "appearance" | "workspace" | "members" | "people";

interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsed: number | null;
  synced: boolean;
}
interface Member {
  email: string;
  role: "owner" | "member";
  addedAt: number;
  user: { id: string; name: string; color: string; avatar: string | null; lastSeen: number | null; passkeys: number } | null;
}
interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeen: number;
  agent: string;
  method: string;
}

const shortDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function useList<T>(path: string, key: string) {
  const [list, setList] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api(path)
      .then((d) => setList(d[key]))
      .catch((e) => setError(e.message));
  }, [path, key]);
  return { list, setList, error, setError };
}

// ---------------------------------------------------------------- profile

function ProfileSection() {
  const me = useMe()!;
  const [error, setError] = useState("");
  const save = (patch: { name?: string; color?: string }) => updateProfile(patch).catch((e) => setError(e.message));
  return (
    <section className="set-section">
      <div className="profile-row">
        <Avatar user={me} size={44} />
        <div className="profile-fields">
          <input
            aria-label="Your name"
            defaultValue={me.name}
            maxLength={40}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== me.name) save({ name: v });
              else e.target.value = me.name;
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="muted small">{me.email}</span>
        </div>
      </div>
      <span className="set-label">Cursor colour</span>
      <div className="swatches">
        {USER_COLORS.map((c) => (
          <button key={c} style={{ background: c }} className={me.color === c ? "active" : ""} onClick={() => save({ color: c })} aria-label={"Colour " + c} />
        ))}
      </div>
      {error && <p className="set-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- passkeys

function PasskeysSection() {
  const { list, setList, error, setError } = useList<Passkey>("/api/passkeys", "passkeys");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  const startEdit = (pk: Passkey) => {
    setEditing(pk.id);
    setDraft(pk.name);
    setJustAdded(null);
  };
  const stopEdit = () => {
    setEditing(null);
    setJustAdded(null);
  };
  const save = async () => {
    const id = editing;
    const name = draft.trim();
    stopEdit();
    if (!id || !name || list?.find((p) => p.id === id)?.name === name) return;
    try {
      setList((await api(`/api/passkeys/${id}`, { method: "PATCH", body: { name } })).passkeys);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const add = async () => {
    setBusy(true);
    setError("");
    const before = new Set((list ?? []).map((p) => p.id));
    try {
      const { challengeId, options } = await api("/api/passkeys/register/options", { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      const d = await api("/api/passkeys/register/verify", { body: { challengeId, response, name: deviceName() } });
      setList(d.passkeys);
      // Ask for a name straight away, starting from the device's name.
      const created = (d.passkeys as Passkey[]).find((p) => !before.has(p.id));
      if (created) {
        setEditing(created.id);
        setDraft(created.name);
        setJustAdded(created.id);
      }
    } catch (e: any) {
      if (e?.name === "InvalidStateError") setError("This device already has a passkey for Sandpiper.");
      else if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setError(e?.message || "Couldn't add the passkey.");
    } finally {
      setBusy(false);
    }
  };

  const remove = (pk: Passkey) => {
    if (!confirm(`Remove the passkey "${pk.name}"? You won't be able to sign in with it any more.`)) return;
    api(`/api/passkeys/${pk.id}`, { method: "DELETE" })
      .then((d) => setList(d.passkeys))
      .catch((e) => setError(e.message));
  };

  return (
    <section className="set-section">
      <h3>Passkeys</h3>
      <p className="muted small">Sign in with your fingerprint, face or device PIN instead of Google. Add one on each device you use; there's no limit.</p>
      <div className="set-list">
        {list?.map((pk) => (
          <div key={pk.id} className="set-row">
            <KeyRound size={16} className="set-row-icon" />
            <div className="set-row-main">
              {editing === pk.id ? (
                <form
                  className="set-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                >
                  {justAdded === pk.id && <span className="set-hint">Passkey added. Give it a name you'll recognise:</span>}
                  <div className="set-rename-row">
                    <input
                      autoFocus
                      aria-label="Passkey name"
                      placeholder="e.g. Alex's iPhone"
                      value={draft}
                      maxLength={60}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          stopEdit();
                        }
                      }}
                    />
                    <button className="btn small" disabled={!draft.trim()}>
                      Save
                    </button>
                    <button type="button" className="btn-ghost small" onClick={stopEdit}>
                      {justAdded === pk.id ? "Keep this name" : "Cancel"}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <span className="set-row-title">{pk.name}</span>
                  <span className="muted small">
                    Added {shortDate(pk.createdAt)} · {pk.lastUsed ? `last used ${relTime(pk.lastUsed)}` : "not used yet"}
                    {pk.synced ? " · synced across your devices" : ""}
                  </span>
                </>
              )}
            </div>
            {editing !== pk.id && (
              <>
                <button className="icon-btn" onClick={() => startEdit(pk)} title="Rename passkey" aria-label={`Rename ${pk.name}`}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn" onClick={() => remove(pk)} title="Remove passkey" aria-label={`Remove ${pk.name}`}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
        {list?.length === 0 && <div className="muted small set-empty">No passkeys yet.</div>}
      </div>
      {supported ? (
        <button className="btn-ghost set-add-btn" onClick={add} disabled={busy}>
          <Plus size={15} /> {busy ? "Waiting for your device…" : "Add a passkey on this device"}
        </button>
      ) : (
        <p className="muted small">This browser doesn't support passkeys.</p>
      )}
      {error && <p className="set-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- members

function MembersSection() {
  const me = useMe()!;
  const { list, setList, error, setError } = useList<Member>("/api/members", "members");
  const [email, setEmail] = useState("");
  const isOwner = me.role === "owner";

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError("");
    api("/api/members", { body: { email } })
      .then((d) => {
        setList(d.members);
        setEmail("");
      })
      .catch((err) => setError(err.message));
  };
  const remove = (m: Member) => {
    const who = m.user?.name ?? m.email;
    if (!confirm(`Remove ${who} from Sandpiper? They'll be signed out everywhere and won't be able to sign in. Their past edits keep their name.`)) return;
    api(`/api/members/${encodeURIComponent(m.email)}`, { method: "DELETE" })
      .then((d) => setList(d.members))
      .catch((err) => setError(err.message));
  };

  return (
    <section className="set-section">
      <p className="muted small">
        Adding someone here doesn't put them in any workspace; whoever manages a workspace chooses who's in it. Removing someone signs
        them out everywhere.
      </p>
      <div className="set-list">
        {list?.map((m) => (
          <div key={m.email} className="set-row">
            {m.user ? <Avatar user={m.user} size={28} /> : <span className="avatar avatar-empty" style={{ width: 28, height: 28 }} />}
            <div className="set-row-main">
              <span className="set-row-title">
                {m.user?.name ?? m.email}
                {m.email === me.email && <span className="muted"> (you)</span>}
                {m.role === "owner" && <span className="badge">Owner</span>}
              </span>
              <span className="muted small">
                {m.user ? m.email : "Hasn't signed in yet"}
                {m.user?.lastSeen ? ` · active ${relTime(m.user.lastSeen)}` : ""}
              </span>
            </div>
            {isOwner && m.email !== me.email && (
              <button className="icon-btn" onClick={() => remove(m)} title="Remove from Sandpiper" aria-label={`Remove ${m.user?.name ?? m.email}`}>
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
      {isOwner ? (
        <form className="set-add" onSubmit={add}>
          <input type="email" placeholder="Google email address" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to add" />
          <button className="btn small" disabled={!email.trim()}>
            Add person
          </button>
        </form>
      ) : (
        <p className="muted small">Only the owner of Sandpiper can add or remove people.</p>
      )}
      {error && <p className="set-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- devices

function DevicesSection() {
  const { list, setList, error, setError } = useList<SessionInfo>("/api/sessions", "sessions");
  const revoke = (s: SessionInfo) =>
    api(`/api/sessions/${s.id}`, { method: "DELETE" })
      .then((d) => setList(d.sessions))
      .catch((e) => setError(e.message));
  return (
    <section className="set-section">
      <h3>Signed-in devices</h3>
      <div className="set-list">
        {list?.map((s) => (
          <div key={s.id} className="set-row">
            <Monitor size={16} className="set-row-icon" />
            <div className="set-row-main">
              <span className="set-row-title">
                {deviceName(s.agent)}
                {s.current && <span className="badge">This device</span>}
              </span>
              <span className="muted small">
                Signed in with {s.method === "passkey" ? "a passkey" : "Google"} · {s.current ? "active now" : `active ${relTime(s.lastSeen)}`}
              </span>
            </div>
            {!s.current && (
              <button className="btn-ghost small" onClick={() => revoke(s)}>
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="row gap set-signout">
        <button className="btn-ghost" onClick={() => signOut(false)}>
          <LogOut size={15} /> Sign out
        </button>
        <button
          className="btn-ghost"
          onClick={() => confirm("Sign out on every device, including this one?") && signOut(true)}
        >
          Sign out everywhere
        </button>
      </div>
      {error && <p className="set-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- appearance

function AppearanceSection({ pref, setPref }: { pref: ThemePref; setPref: (t: ThemePref) => void }) {
  return (
    <section className="set-section">
      <div className="seg">
        {(
          [
            ["system", "System", <Monitor size={14} />],
            ["light", "Light", <Sun size={14} />],
            ["dark", "Dark", <Moon size={14} />],
          ] as const
        ).map(([k, label, icon]) => (
          <button key={k} className={pref === k ? "active" : ""} onClick={() => setPref(k)}>
            {icon} {label}
          </button>
        ))}
      </div>
      <p className="muted small">Saved in this browser only, so each device can have its own.</p>
    </section>
  );
}

// ---------------------------------------------------------------- modal

interface NavItem {
  tab: SettingsTab;
  label: string;
  icon: ReactNode;
}
interface NavGroup {
  label: ReactNode;
  /** Plain-text group name (a stable key). */
  name: string;
  items: NavItem[];
}

export function SettingsModal({
  onClose,
  pref,
  setPref,
  initialTab = "profile",
}: {
  onClose: () => void;
  pref: ThemePref;
  setPref: (t: ThemePref) => void;
  initialTab?: SettingsTab;
}) {
  const me = useMe()!;
  const ws = useWorkspaceName();
  const isOwner = me.role === "owner";
  const [tab, setTab] = useState<SettingsTab>(initialTab === "people" && !isOwner ? "profile" : initialTab);

  const groups: NavGroup[] = [
    {
      label: "Your account",
      name: "Your account",
      items: [
        { tab: "profile", label: "Profile", icon: <User size={15} /> },
        { tab: "security", label: "Sign-in & devices", icon: <KeyRound size={15} /> },
        { tab: "ai", label: "AI & apps", icon: <Plug size={15} /> },
        { tab: "appearance", label: "Appearance", icon: <SunMoon size={15} /> },
      ],
    },
    {
      label: (
        <span className="settings-nav-stack">
          <span>Workspace</span>
          <span className="settings-nav-ws">
            <WorkspaceIcon id={WS_ID} name={ws.name} icon={ws.icon} size={16} />
            <span>{ws.name}</span>
          </span>
        </span>
      ),
      name: "Workspace",
      items: [
        { tab: "workspace", label: "General", icon: <SlidersHorizontal size={15} /> },
        { tab: "members", label: "Members", icon: <Users size={15} /> },
      ],
    },
  ];
  if (isOwner) {
    groups.push({
      label: "App",
      name: "App",
      items: [{ tab: "people", label: "Who can sign in", icon: <ShieldCheck size={15} /> }],
    });
  }
  const group = groups.find((g) => g.items.some((i) => i.tab === tab))!;
  const item = group.items.find((i) => i.tab === tab)!;
  const descriptions: Record<SettingsTab, string> = {
    profile: "How you appear to everyone, on every device.",
    security: "The ways you sign in, and every device you're signed in on.",
    ai: "AI apps that can work in Sandpiper as you, and how to connect one.",
    appearance: "How Sandpiper looks on this device.",
    workspace: `The name and icon of ${ws.name}, shared by everyone in it.`,
    members: `Who can open ${ws.name}.`,
    people: "Who can sign in to Sandpiper at all. Only you see this.",
  };

  return (
    <Modal onClose={onClose} className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          {groups.map((g) => (
            <div key={g.name} className="settings-nav-group">
              <div className="settings-nav-label">{g.label}</div>
              {g.items.map((i) => (
                <button
                  key={i.tab}
                  type="button"
                  className={"settings-nav-item" + (i.tab === tab ? " active" : "")}
                  aria-current={i.tab === tab ? "page" : undefined}
                  onClick={() => setTab(i.tab)}
                >
                  {i.icon}
                  <span>{i.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-pane">
          <div className="settings-pane-head">
            <div className="settings-pane-title">
              <h2>{item.label}</h2>
              <p className="settings-pane-desc">{descriptions[tab]}</p>
            </div>
            <button className="icon-btn" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
          <div className="settings-body" key={tab}>
            {tab === "profile" && <ProfileSection />}
            {tab === "security" && (
              <>
                <PasskeysSection />
                <DevicesSection />
              </>
            )}
            {tab === "ai" && <ConnectionsSection />}
            {tab === "appearance" && <AppearanceSection pref={pref} setPref={setPref} />}
            {tab === "workspace" && <WorkspaceGeneral />}
            {tab === "members" && <WorkspaceMembers />}
            {tab === "people" && isOwner && <MembersSection />}
          </div>
        </div>
      </div>
    </Modal>
  );
}
