// Settings → AI & apps: how to connect an AI app to Sandpiper's MCP server, the apps connected now (each can be
// disconnected), and access tokens for apps that take one instead of signing in.
import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, KeyRound, Plus } from "lucide-react";
import { api } from "../api";
import { useWorkspaces } from "../store";
import { relTime, toast } from "./ui";
import { AccessPicker, accessSummary, type Access } from "./AccessPicker";

interface Connection {
  id: string;
  kind: "oauth" | "token";
  name: string;
  access: Access;
  workspaces: string[] | null;
  createdAt: number;
  lastUsed: number | null;
}

const shortDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const MCP_URL = `${location.origin}/mcp`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title={label}
      aria-label={label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast("Couldn't copy. Select the text and copy it instead."),
        )
      }
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function CopyField({ value, label, mono }: { value: string; label: string; mono?: boolean }) {
  return (
    <div className="copy-field">
      <input readOnly value={value} aria-label={label} className={mono ? "mono" : ""} onFocus={(e) => e.currentTarget.select()} />
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

export function ConnectionsSection() {
  const workspaces = useWorkspaces();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name ?? "Untitled workspace"])), [workspaces]);
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("write");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<{ name: string; value: string } | null>(null);

  useEffect(() => {
    api("/api/connections")
      .then((d) => setList(d.connections))
      .catch((e) => setError(e.message));
  }, []);

  const disconnect = (c: Connection) => {
    const what = c.kind === "token" ? `the token "${c.name}"` : c.name;
    if (!confirm(`Disconnect ${what}? It stops working straight away.`)) return;
    api(`/api/connections/${c.id}`, { method: "DELETE" })
      .then((d) => setList(d.connections))
      .catch((e) => setError(e.message));
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const d = await api("/api/connections/tokens", { body: { name, access, workspaces: picked } });
      setList(d.connections);
      setToken({ name: name.trim(), value: d.token });
      setCreating(false);
      setName("");
      setAccess("write");
      setPicked(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <p className="muted small">
          Let Claude, ChatGPT or another AI app work in Sandpiper for you: read and write pages, organise them, fill in databases, tick
          things off. It acts as you, so it can do what you can, only in the workspaces you choose.
        </p>
        <span className="set-label">Sandpiper's MCP server address</span>
        <CopyField value={MCP_URL} label="Server address" />
        <ul className="ai-steps">
          <li>
            <b>Claude</b> (web and desktop): Settings → Connectors → Add custom connector. Paste the address, then Connect, and choose what it
            can reach.
          </li>
          <li>
            <b>Claude Code</b>: run this, then <code>/mcp</code> in Claude Code to sign in.
            <CopyField value={`claude mcp add --transport http sandpiper ${MCP_URL}`} label="Command" mono />
          </li>
          <li>
            <b>Other apps</b>: paste the address wherever they take an MCP server. If one asks for a token instead of signing in, create one
            below.
          </li>
        </ul>
      </section>

      <section className="set-section">
        <h3>Connected</h3>
        <div className="set-list">
          {list?.map((c) => (
            <div key={c.id} className="set-row">
              {c.kind === "token" ? <KeyRound size={16} className="set-row-icon" /> : <Bot size={16} className="set-row-icon" />}
              <div className="set-row-main">
                <span className="set-row-title">
                  {c.name}
                  {c.kind === "token" && <span className="badge">Token</span>}
                </span>
                <span className="muted small">
                  {accessSummary(c.access, c.workspaces, names)} · {c.kind === "token" ? "created" : "connected"} {shortDate(c.createdAt)} ·{" "}
                  {c.lastUsed ? `used ${relTime(c.lastUsed)}` : "not used yet"}
                </span>
              </div>
              <button className="btn-ghost small" onClick={() => disconnect(c)}>
                Disconnect
              </button>
            </div>
          ))}
          {list?.length === 0 && <div className="muted small set-empty">No AI apps connected yet.</div>}
          {list === null && !error && <div className="muted small set-empty">Loading…</div>}
        </div>
      </section>

      <section className="set-section">
        <h3>Access tokens</h3>
        <p className="muted small">For apps that ask for a token rather than signing you in. A token works until you disconnect it.</p>
        {token && (
          <div className="token-reveal" role="status">
            <span className="set-hint">Token "{token.name}" created. Copy it now: it won't be shown again.</span>
            <CopyField value={token.value} label="Access token" mono />
            <span className="muted small">
              Apps send it as the header <code>Authorization: Bearer …</code> with the server address above.
            </span>
            <button className="btn-ghost small" onClick={() => setToken(null)}>
              Done
            </button>
          </div>
        )}
        {creating ? (
          <form className="token-form" onSubmit={create}>
            <input autoFocus placeholder="Name, e.g. the app it's for" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
            <AccessPicker
              access={access}
              setAccess={setAccess}
              picked={picked}
              setPicked={setPicked}
              workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon }))}
            />
            <div className="row gap">
              <button className="btn small" disabled={busy || !name.trim() || (picked !== null && picked.length === 0)}>
                {busy ? "Creating…" : "Create token"}
              </button>
              <button type="button" className="btn-ghost small" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="btn-ghost set-add-btn" onClick={() => (setCreating(true), setToken(null))}>
            <Plus size={15} /> Create a token
          </button>
        )}
        {error && <p className="set-error">{error}</p>}
      </section>
    </>
  );
}
