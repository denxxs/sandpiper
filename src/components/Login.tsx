import { useState } from "react";
import { KeyRound } from "lucide-react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { api } from "../api";
import { loadSession } from "../store";
import { LogoGlyph, Wordmark } from "./Logo";

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The sign-in card. `next` returns there after Google (only an AI app's approval page); `onSignedIn` runs after a passkey. */
export function LoginScreen({ error, next, lead, onSignedIn }: { error?: string; next?: string; lead?: string; onSignedIn?: () => void }) {
  const [busy, setBusy] = useState<"google" | "passkey" | null>(null);
  const [message, setMessage] = useState(error ?? "");
  const passkeys = browserSupportsWebAuthn();

  const signInWithPasskey = async () => {
    setBusy("passkey");
    setMessage("");
    try {
      const { challengeId, options } = await api("/api/auth/passkey/options", { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/auth/passkey/verify", { body: { challengeId, response } });
      if (onSignedIn) onSignedIn();
      else await loadSession();
    } catch (e: any) {
      // Closing the browser's passkey prompt isn't an error worth showing.
      if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setMessage(e?.message || "Passkey sign-in didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="welcome">
      <main className="welcome-card login-card">
        <div className="welcome-logo">
          <LogoGlyph tight />
        </div>
        <h1 className="login-wordmark">
          <Wordmark />
        </h1>
        <p className="muted">{lead ?? "Your shared space. Sign in to continue."}</p>

        <a
          className={"btn-google" + (busy ? " disabled" : "")}
          href={next ? `/auth/google?next=${encodeURIComponent(next)}` : "/auth/google"}
          onClick={(e) => (busy ? e.preventDefault() : setBusy("google"))}
          aria-disabled={!!busy}
        >
          <GoogleMark />
          {busy === "google" ? "Opening Google…" : "Continue with Google"}
        </a>
        {passkeys && (
          <button className="btn-passkey" onClick={signInWithPasskey} disabled={!!busy}>
            <KeyRound size={17} />
            {busy === "passkey" ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </button>
        )}

        {message && (
          <p className="login-error" role="alert">
            {message}
          </p>
        )}
        <p className="muted small login-note">
          Only people added to Sandpiper can sign in. After your first Google sign-in, you can add a passkey in Settings.
        </p>
      </main>
    </div>
  );
}
