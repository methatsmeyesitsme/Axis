import { Router, type IRouter } from "express";
import { db, githubConnections } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const router: IRouter = Router();

// ── Auth options ─────────────────────────────────────────────────────────────
// 1) Easy path (recommended): set GITHUB_TOKEN secret to a Personal Access Token
//    → no OAuth App needed
// 2) Full OAuth path (optional): GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET

const GITHUB_CLIENT_ID = process.env["GITHUB_CLIENT_ID"];
const GITHUB_CLIENT_SECRET = process.env["GITHUB_CLIENT_SECRET"];
const GITHUB_OAUTH_CALLBACK_URL = process.env["GITHUB_OAUTH_CALLBACK_URL"]?.trim();
const GITHUB_TOKEN_ENV = process.env["GITHUB_TOKEN"]?.trim(); // Personal Access Token (easy path)

const GITHUB_OAUTH_SCOPE = "repo read:user";

// ── Token encryption (AES-256-GCM) ──────────────────────────────────────────

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
  // Plain env tokens are not encrypted
  if (!payload.includes(".")) return payload;
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = crypto.createDecipheriv(ENC_ALGO, getEncryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

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
}

async function fetchGithubUser(token: string): Promise<{ id: number; login: string; avatar_url: string } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Axis" },
  });
  if (!res.ok) return null;
  return (await res.json()) as { id: number; login: string; avatar_url: string };
}

/**
 * Returns the user's GitHub connection.
 * Priority:
 *  1. Per-user DB connection (OAuth or saved PAT)
 *  2. Global GITHUB_TOKEN env secret (simple no-OAuth path)
 */
export async function getUserGithubConnection(userId: number) {
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));
  if (conn) return conn;

  // Fallback: global Personal Access Token from secrets
  if (GITHUB_TOKEN_ENV) {
    return {
      id: -1,
      userId,
      githubUserId: "env",
      login: "token",
      avatarUrl: null as string | null,
      encryptedAccessToken: GITHUB_TOKEN_ENV, // plain token; decryptToken handles this
      selectedOwner: process.env["GITHUB_DEFAULT_OWNER"] ?? null,
      selectedRepo: process.env["GITHUB_DEFAULT_REPO"] ?? null,
      selectedBranch: process.env["GITHUB_DEFAULT_BRANCH"] ?? "main",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * Easy connect: paste a Personal Access Token (no OAuth App required).
 * Body: { token: "ghp_...", owner?: string, repo?: string, branch?: string }
 */
router.post("/connect-token", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Log in first" }); return; }

  const { token, owner, repo, branch } = req.body as {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
  };

  if (!token?.trim()) {
    res.status(400).json({ error: "token is required (create one at https://github.com/settings/tokens)" });
    return;
  }

  const ghUser = await fetchGithubUser(token.trim());
  if (!ghUser) {
    res.status(400).json({ error: "Invalid GitHub token (or missing repo scope)" });
    return;
  }

  const encryptedAccessToken = encryptToken(token.trim());
  const [existing] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId));

  if (existing) {
    await db
      .update(githubConnections)
      .set({
        githubUserId: String(ghUser.id),
        login: ghUser.login,
        avatarUrl: ghUser.avatar_url,
        encryptedAccessToken,
        selectedOwner: owner ?? existing.selectedOwner,
        selectedRepo: repo ?? existing.selectedRepo,
        selectedBranch: branch ?? existing.selectedBranch ?? "main",
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, existing.id));
  } else {
    await db.insert(githubConnections).values({
      userId,
      githubUserId: String(ghUser.id),
      login: ghUser.login,
      avatarUrl: ghUser.avatar_url,
      encryptedAccessToken,
      selectedOwner: owner ?? null,
      selectedRepo: repo ?? null,
      selectedBranch: branch ?? "main",
    });
  }

  res.json({ ok: true, login: ghUser.login });
});

// Optional OAuth path (kept for people who already set up an OAuth App)
router.get("/oauth/start", (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: "Log in first" }); return; }
  if (!GITHUB_CLIENT_ID) {
    res.status(500).json({
      error: "OAuth is not configured. Use a Personal Access Token instead (easier). Set GITHUB_TOKEN or POST /api/github/connect-token.",
    });
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

    const ghUser = await fetchGithubUser(tokenData.access_token);
    if (!ghUser) {
      res.redirect(withGithubResult(returnTo, "error"));
      return;
    }

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

router.get("/oauth/config", (req, res) => {
  try {
    res.json({
      callbackUrl: buildRedirectUri(req),
      patSupported: true,
      hasEnvToken: !!GITHUB_TOKEN_ENV,
    });
  } catch {
    res.status(500).json({ error: "Unable to determine the GitHub OAuth callback URL" });
  }
});

router.get("/status", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.json({ connected: false }); return; }

  const conn = await getUserGithubConnection(userId);
  if (!conn) { res.json({ connected: false, patSupported: true }); return; }

  res.json({
    connected: true,
    login: conn.login,
    avatarUrl: conn.avatarUrl,
    selectedOwner: conn.selectedOwner,
    selectedRepo: conn.selectedRepo,
    selectedBranch: conn.selectedBranch,
    viaEnvToken: conn.id === -1,
    patSupported: true,
  });
});

router.get("/repos", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Log in first" }); return; }

  const conn = await getUserGithubConnection(userId);
  if (!conn) { res.status(400).json({ error: "GitHub is not connected. Add a Personal Access Token." }); return; }

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

  // If only using env token, store the selection in a lightweight DB row
  if (!conn) {
    if (!GITHUB_TOKEN_ENV) {
      res.status(400).json({ error: "GitHub is not connected" });
      return;
    }
    const ghUser = await fetchGithubUser(GITHUB_TOKEN_ENV);
    await db.insert(githubConnections).values({
      userId,
      githubUserId: ghUser ? String(ghUser.id) : "env",
      login: ghUser?.login ?? "token",
      avatarUrl: ghUser?.avatar_url ?? null,
      encryptedAccessToken: encryptToken(GITHUB_TOKEN_ENV),
      selectedOwner: owner,
      selectedRepo: repo,
      selectedBranch: branch ?? "main",
    });
    res.json({ ok: true });
    return;
  }

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
