import { Router, type IRouter } from "express";
import { db, githubConnections } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const router: IRouter = Router();

// GitHub OAuth App credentials — a person must register an OAuth App at
// https://github.com/settings/developers and set these as Replit secrets.
//
// GitHub requires one exact callback URL. Do not derive it from the incoming
// Host header: preview/proxy hosts can change between requests. Set
// GITHUB_OAUTH_CALLBACK_URL to the canonical public callback URL when one is
// available. In Replit development, REPLIT_DEV_DOMAIN is the stable fallback.
const GITHUB_CLIENT_ID = process.env["GITHUB_CLIENT_ID"];
const GITHUB_CLIENT_SECRET = process.env["GITHUB_CLIENT_SECRET"];
const GITHUB_OAUTH_CALLBACK_URL = process.env["GITHUB_OAUTH_CALLBACK_URL"]?.trim();

// Requests read/write access to the person's repos (not just profile info),
// per the requirement that Axis be able to read AND write via this connection.
const GITHUB_OAUTH_SCOPE = "repo read:user";

// ── Token encryption (AES-256-GCM) ──────────────────────────────────────────
// Access tokens are stored encrypted at rest, never in plaintext, and are
// only ever decrypted server-side for the one request that needs to call the
// GitHub API on the person's behalf.

const ENC_ALGO = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const secret = process.env["GITHUB_TOKEN_ENCRYPTION_KEY"] ?? process.env["SESSION_SECRET"] ?? "fallback-dev-secret";
  return crypto.scryptSync(secret, "axis-github-token", 32);
}

function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptToken(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = crypto.createDecipheriv(ENC_ALGO, getEncryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

// GitHub OAuth Apps only accept ONE fixed, exact callback URL — no wildcards,
// no multiple entries. The dev preview URL for this workspace changes
// between sessions, so it can never reliably match a single registered
// value. GITHUB_OAUTH_BASE_URL should be set once to whatever stable URL is
// actually registered as the callback on GitHub (ideally a published
// deployment domain) — every OAuth request routes through that fixed URL
// regardless of which ephemeral preview URL the person is currently on.
// Falls back to the dynamic host only if that's not set (fine for a setup
// that genuinely only ever has one, already-stable URL).
function buildRedirectUri(req: { get(name: string): string | undefined }): string {
  if (GITHUB_OAUTH_CALLBACK_URL) return GITHUB_OAUTH_CALLBACK_URL;
  const stableHost = process.env["REPLIT_DEV_DOMAIN"]?.trim() || req.get("host");
  if (!stableHost) throw new Error("Unable to determine the GitHub OAuth callback host");
  return `https://${stableHost}/api/github/oauth/callback`;
}

function normalizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://axis.invalid");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function withGithubResult(returnTo: string, result: "connected" | "error"): string {
  const separator = returnTo.includes("?") ? "&" : "?";
  return `${returnTo}${separator}github=${result}`;
  function withGithubResult(returnTo: string, result: "connected" | "error"): string {
    const separator = returnTo.includes("?") ? "&" : "?";
    return `${returnTo}${separator}github=${result}`;
  }

  function buildRedirectUri(req: { get(name: string): string | undefined }): string {
    const base = process.env["GITHUB_OAUTH_BASE_URL"];
    if (base) return `${base.replace(/\/$/, "")}/api/github/oauth/callback`;
    return `https://${req.get("host")}/api/github/oauth/callback`;
  }

}

export async function getUserGithubConnection(userId: number) {
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
  return conn ?? null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/oauth/start", (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: "Log in first" }); return; }
  if (!GITHUB_CLIENT_ID) {
    res.status(500).json({ error: "GitHub integration is not configured (missing GITHUB_CLIENT_ID)" });
    return;
  }

  const state = crypto.randomBytes(24).toString("hex");
  req.session.githubOAuthState = state;
  req.session.githubOAuthReturnTo = normalizeReturnTo(req.query.returnTo);

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: buildRedirectUri(req),
    scope: GITHUB_OAUTH_SCOPE,
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

router.get("/oauth/callback", async (req, res) => {
  const userId = req.session?.userId;
  const returnTo = req.session?.githubOAuthReturnTo ?? "/";
  const expectedState = req.session?.githubOAuthState;
  req.session.githubOAuthState = undefined;
  req.session.githubOAuthReturnTo = undefined;

  const { code, state } = req.query as { code?: string; state?: string };
  if (!userId || !code || !state || !expectedState || state !== expectedState) {
    res.redirect(withGithubResult(returnTo, "error"));
    return;
  }
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    res.redirect(withGithubResult(returnTo, "error"));
    return;
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: buildRedirectUri(req),
      }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      res.redirect(withGithubResult(returnTo, "error"));
      return;
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "Axis" },
    });
    const ghUser = (await userRes.json()) as { id: number; login: string; avatar_url: string };

    const encryptedAccessToken = encryptToken(tokenData.access_token);
    const [existing] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
    if (existing) {
      await db
        .update(githubConnections)
        .set({ githubUserId: String(ghUser.id), login: ghUser.login, avatarUrl: ghUser.avatar_url, encryptedAccessToken, updatedAt: new Date() })
        .where(eq(githubConnections.id, existing.id));
    } else {
      await db.insert(githubConnections).values({
        userId,
        githubUserId: String(ghUser.id),
        login: ghUser.login,
        avatarUrl: ghUser.avatar_url,
        encryptedAccessToken,
      });
    }

    res.redirect(withGithubResult(returnTo, "connected"));
  } catch {
    res.redirect(withGithubResult(returnTo, "error"));
  }
});

// Lets the Settings UI (and the person configuring the OAuth App) see the
// exact callback URL Axis is using without exposing any credentials.
router.get("/oauth/config", (req, res) => {
  try {
    res.json({ callbackUrl: buildRedirectUri(req) });
  } catch {
    res.status(500).json({ error: "Unable to determine the GitHub OAuth callback URL" });
  }
});

router.get("/status", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.json({ connected: false }); return; }
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
  if (!conn) { res.json({ connected: false }); return; }
  res.json({
    connected: true,
    login: conn.login,
    avatarUrl: conn.avatarUrl,
    selectedOwner: conn.selectedOwner,
    selectedRepo: conn.selectedRepo,
    selectedBranch: conn.selectedBranch,
  });
});

router.get("/repos", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Log in first" }); return; }
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
  if (!conn) { res.status(400).json({ error: "GitHub is not connected" }); return; }

  const token = decryptToken(conn.encryptedAccessToken);
  const ghRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Axis" },
  });
  if (!ghRes.ok) { res.status(502).json({ error: "Failed to list GitHub repositories" }); return; }

  const repos = (await ghRes.json()) as Array<{ full_name: string; owner: { login: string }; name: string; default_branch: string; private: boolean }>;
  res.json(repos.map((r) => ({ owner: r.owner.login, repo: r.name, fullName: r.full_name, defaultBranch: r.default_branch, private: r.private })));
});

router.post("/select", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Log in first" }); return; }
  const { owner, repo, branch } = req.body as { owner?: string; repo?: string; branch?: string };
  if (!owner || !repo) { res.status(400).json({ error: "owner and repo are required" }); return; }

  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
  if (!conn) { res.status(400).json({ error: "GitHub is not connected" }); return; }

  await db
    .update(githubConnections)
    .set({ selectedOwner: owner, selectedRepo: repo, selectedBranch: branch ?? "main", updatedAt: new Date() })
    .where(eq(githubConnections.id, conn.id));
  res.json({ ok: true });
});

router.post("/disconnect", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Log in first" }); return; }
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
  res.json({ ok: true });
});

export default router;
