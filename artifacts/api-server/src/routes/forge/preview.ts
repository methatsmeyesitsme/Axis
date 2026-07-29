import { Router, type IRouter, type Response } from "express";
import { db, conversations, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { executeBackendHandler } from "./sandbox";

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
  const result = await executeBackendHandler(id, {
    method: req.method,
    route,
    query: req.query as Record<string, string>,
    body: req.body,
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
