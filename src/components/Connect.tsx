// /connect: where an AI app (Claude, ChatGPT…) sends you to approve it. You see who's asking and where you'll be
// sent back to, choose what it may do and in which workspaces, then allow or cancel. Signing in first, if needed,
// comes back here.
import { useEffect, useState } from "react";
import { getLocal } from "../store";
import { LoginScreen } from "./Login";
import { LogoGlyph } from "./Logo";
import { AccessPicker, type Access, type WorkspaceChoice } from "./AccessPicker";

interface RequestInfo {
  client: { name: string; uri: string | null; redirectHost: string };
  me: { name: string; email: string };
  workspaces: WorkspaceChoice[];
}

const ERRORS: Record<string, string> = {
  unknown_app: "The app that sent you here isn't registered with Sandpiper, or its registration expired. Start connecting again from the app.",
  bad_redirect: "The app that sent you here gave an address to return to that it didn't register. For your safety, Sandpiper stopped here.",
};

function useConnectTheme() {
  useEffect(() => {
    const pref = getLocal<string>("theme", "system");
    const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.title = "Connect an app — Sandpiper";
  }, []);
}

export function ConnectApp() {
  useConnectTheme();
  const params = new URLSearchParams(location.search);
  const id = params.get("request") ?? "";
  const error = params.get("error");
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "gone" | "done">(error || !id ? "gone" : "loading");
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [message, setMessage] = useState(error ? (ERRORS[error] ?? ERRORS.unknown_app) : !id ? "This link is missing its request. Start connecting again from the app." : "");
  const [access, setAccess] = useState<Access>("write");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const me = await fetch("/api/auth/me").catch(() => null);
    if (!me) return (setState("gone"), setMessage("Can't reach Sandpiper right now. Check your connection and try again."));
    if (me.status === 401) return setState("signed-out");
    const res = await fetch(`/api/oauth/requests/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) return (setState("gone"), setMessage(data?.error ?? "This request has expired. Start connecting again from the app you were using."));
    setInfo(data);
    setState("ready");
  };
  useEffect(() => {
    if (state === "loading") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (allow: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/oauth/requests/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow, access, workspaces: picked }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "That didn't work. Try again.");
      if (allow) setState("done");
      location.assign(data.redirect);
    } catch (e: any) {
      setMessage(e.message);
      setBusy(false);
    }
  };

  if (state === "loading") {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    );
  }
  if (state === "signed-out") {
    return <LoginScreen next={`/connect?request=${id}`} lead="Sign in to connect an app to Sandpiper." onSignedIn={() => (setState("loading"), load())} />;
  }

  const name = info?.client.name ?? "This app";
  return (
    <div className="welcome">
      <main className="welcome-card login-card connect-card">
        <div className="welcome-logo">
          <LogoGlyph tight />
        </div>
        {state === "gone" ? (
          <>
            <h1>Can't connect</h1>
            <p className="muted">{message}</p>
          </>
        ) : state === "done" ? (
          <>
            <h1>Connected</h1>
            <p className="muted">Taking you back to {name}…</p>
          </>
        ) : (
          <>
            <h1 className="connect-title">Connect {name}?</h1>
            <p className="muted">
              {name} will use Sandpiper as you ({info!.me.email}).{" "}
              {access === "write"
                ? "It can do anything you can in the workspaces you choose: read, write, organise, tick things off, delete."
                : "It can read everything you can in the workspaces you choose, and change nothing."}
            </p>
            <AccessPicker access={access} setAccess={setAccess} picked={picked} setPicked={setPicked} workspaces={info!.workspaces} />
            {message && (
              <p className="login-error" role="alert">
                {message}
              </p>
            )}
            <div className="connect-actions">
              <button className="btn-ghost" onClick={() => decide(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn" onClick={() => decide(true)} disabled={busy || (picked !== null && picked.length === 0)}>
                {busy ? "Connecting…" : "Allow"}
              </button>
            </div>
            <p className="muted small connect-note">
              {info!.client.redirectHost ? <>You'll go back to {info!.client.redirectHost}. </> : null}
              Disconnect it any time in Settings → AI &amp; apps.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
