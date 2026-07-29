import { Router, type IRouter, type Request, type Response } from "express";
import { db, conversations, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { executeBackendHandler } from "./sandbox";
import { signup, login, getSessionUser, destroySession } from "./forge-accounts";

const router: IRouter = Router();

// ── MIME map ─────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  txt: "text/plain",
};

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// Express 5 (path-to-regexp v6+) requires named wildcards; the matched
// segments come back as an array under req.params.splat.
function joinSplat(splat: unknown): string {
  if (Array.isArray(splat)) return splat.join("/");
  return typeof splat === "string" ? splat : "";
}

async function isForgeApp(id: number): Promise<boolean> {
  if (Number.isNaN(id)) return false;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  return !!conv && conv.source === "forge";
}

async function serveFile(id: number, path: string, res: Response): Promise<void> {
  if (!(await isForgeApp(id))) {
    res.status(404).send("App not found");
    return;
  }

  const [file] = await db
    .select()
    .from(forgeAppFiles)
    .where(and(eq(forgeAppFiles.appId, id), eq(forgeAppFiles.path, path)));

  if (!file) {
    if (path === "index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        "<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem;color:#666\">" +
          "<p>This app doesn't have an <code>index.html</code> yet — ask Forge to build one first.</p>" +
          "</body></html>",
      );
      return;
    }
    res.status(404).send("Not found");
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", getMimeType(path));
  res.send(file.content);
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

// Built-in account endpoints, reserved under "_auth/" so they can't collide
// with routes an app author defines with write_backend_handler. Handled here
// directly rather than via the sandbox, since they touch real credentials.
async function handleAuthRoute(
  appId: number,
  route: string,
  req: Request,
  res: Response,
  token: string | undefined,
): Promise<void> {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };

  if (route === "/_auth/signup" && req.method === "POST") {
    const result = await signup(appId, String(body.email ?? ""), String(body.password ?? ""));
    if ("error" in result) { res.status(400).json({ error: result.error }); return; }
    res.status(201).json(result);
    return;
  }

  if (route === "/_auth/login" && req.method === "POST") {
    const result = await login(appId, String(body.email ?? ""), String(body.password ?? ""));
    if ("error" in result) { res.status(401).json({ error: result.error }); return; }
    res.status(200).json(result);
    return;
  }

  if (route === "/_auth/logout" && req.method === "POST") {
    await destroySession(token);
    res.status(200).json({ ok: true });
    return;
  }

  if (route === "/_auth/me" && req.method === "GET") {
    const user = await getSessionUser(appId, token);
    res.status(200).json({ user });
    return;
  }

  res.status(404).json({ error: "Unknown auth route" });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// No trailing slash: redirect to one. A trailing slash keeps the app's own
// relative fetch()/asset paths (e.g. "style.css", "api/todos") resolving
// against this preview's base path instead of dropping the :id segment.
router.get("/:id", (req, res) => {
  const qsIndex = req.originalUrl.indexOf("?");
  const qs = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : "";
  res.redirect(302, `${req.baseUrl}${req.path}/${qs}`);
});

router.get("/:id/", async (req, res) => {
  await serveFile(Number(req.params.id), "index.html", res);
});

// Backend handlers defined via write_backend_handler are exposed relative to
// the preview base path under "api/" — registered before the static
// wildcard below so it takes precedence, for any HTTP method.
router.all("/:id/api/*splat", async (req, res) => {
  const id = Number(req.params.id);
  if (!(await isForgeApp(id))) {
    res.status(404).json({ error: "App not found" });
    return;
  }

  const route = "/" + joinSplat((req.params as Record<string, unknown>).splat);
  const token = extractBearerToken(req.headers.authorization);

  if (route.startsWith("/_auth/")) {
    await handleAuthRoute(id, route, req, res, token);
    return;
  }

  const user = await getSessionUser(id, token);
  const result = await executeBackendHandler(id, {
    method: req.method,
    route,
    query: req.query as Record<string, string>,
    body: req.body,
    user,
  });
  res.status(result.status).json(result.body);
});

// Static frontend files written via write_file.
router.get("/:id/*splat", async (req, res) => {
  const id = Number(req.params.id);
  const path = joinSplat((req.params as Record<string, unknown>).splat) || "index.html";
  await serveFile(id, path, res);
});

export default router;
