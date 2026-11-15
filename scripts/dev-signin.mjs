// A stand-in for Google sign-in, so you can try Sandpiper locally without creating a Google OAuth client.
// Used by `npm run dev:demo`. The server honours it only in local development (LOCAL_DEV=1), never when deployed.
//
// Everyone who clicks "Continue with Google" is signed in as DEMO_EMAIL (default you@example.com, the owner in
// wrangler.jsonc's INITIAL_MEMBERS). To try a second person, run with DEMO_EMAIL set to another member's address.
//
//   GET  /auth    redirects straight back with a code (no page)
//   POST /token   returns an id_token for that code
import http from "node:http";

const PORT = 9911;
const ISS = `http://127.0.0.1:${PORT}`;
const EMAIL = process.env.DEMO_EMAIL || "you@example.com";
const NAME = process.env.DEMO_NAME || EMAIL.split("@")[0].replace(/^./, (c) => c.toUpperCase());
const codes = new Map();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ISS);
    if (url.pathname === "/auth") {
      const code = Math.random().toString(36).slice(2);
      codes.set(code, { nonce: url.searchParams.get("nonce"), client: url.searchParams.get("client_id") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const form = new URLSearchParams(body);
      const info = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!info || !form.get("code_verifier")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const claims = {
        iss: ISS,
        aud: info.client,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: info.nonce,
        sub: "local-" + EMAIL,
        email: EMAIL,
        email_verified: true,
        name: NAME,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id_token: `${b64({ alg: "none" })}.${b64(claims)}.local` }));
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Local sign-in: everyone signs in as ${EMAIL}`));
