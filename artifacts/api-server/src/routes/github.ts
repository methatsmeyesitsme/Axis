import { Router, type IRouter } from "express";
import { db, githubConnections } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const router: IRouter = Router();

// GitHub OAuth App credentials — a person must register an OAuth App at
// https://github.com/settings/developers and set these as Replit secrets.
// The "Authorization callback URL" registered there must exactly match
// what buildRedirectUri() constructs below.
const GITHUB_CLIENT_ID = process.env["GITHUB_CLIENT_ID"];
const GITHUB_CLIENT_SECRET = process.env["GITHUB_CLIENT_SECRET"];

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

function decryptToken(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = crypto.createDecipheriv(ENC_ALGO, getEncryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

function buildRedirectUri(req: { get(name: string): string | undefined }): string {
  return `https://${req.get("host")}/api/github/oauth/callback`;
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
  req.session.githubOAuthReturnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";

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
  req.session.githubOAuthState = undefined;
  req.session.githubOAuthReturnTo = undefined;

  const { code, state } = req.query as { code?: string; state?: string };
  if (!userId || !code || !state || state !== req.session.githubOAuthState) {
    res.redirect(`${returnTo}?github=error`);
    return;
  }
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    res.redirect(`${returnTo}?github=error`);
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
      res.redirect(`${returnTo}?github=error`);
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

    res.redirect(`${returnTo}?github=connected`);
  } catch {
    res.redirect(`${returnTo}?github=error`);
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
