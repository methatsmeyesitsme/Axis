import { Router, type IRouter, type Request, type Response } from "express";
import { db, conversations, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { executeBackendHandler } from "./sandbox";
import { signup, login, getSessionUser, destroySession } from "./forge-accounts";

const router: IRouter = Router();

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

function joinSplat(splat: unknown): string {
  if (Array.isArray(splat)) return splat.join("/");
  return typeof splat === "string" ? splat : "";
}

/** Inject base href, viewport, and full-viewport body styles so previews fill the screen. */
function injectPreviewPolish(html: string, baseHref: string): string {
  let out = html;

  if (!/<base\s/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    } else {
      out = `<!doctype html><html><head><base href="${baseHref}"></head><body>${out}</body></html>`;
    }
  }

  if (!/<meta[^>]+name=["']viewport["']/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">`,
    );
  }

  // Ensure the page can fill a phone / iframe viewport
  const fillCss =
    `<style id="forge-preview-fill">` +
    `html,body{height:100%;min-height:100%;min-height:100dvh;margin:0;}` +
    `</style>`;
  if (!/id=["']forge-preview-fill["']/.test(out)) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${fillCss}</head>`);
    } else if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1>${fillCss}`);
    }
  }

  return out;
}

async function isForgeApp(id: number): Promise<boolean> {
  if (Number.isNaN(id)) return false;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  return !!conv && conv.source === "forge";
}

async function serveFile(id: number, path: string, res: Response, baseHref?: string): Promise<void> {
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
      const others = await db
        .select({ path: forgeAppFiles.path })
        .from(forgeAppFiles)
        .where(eq(forgeAppFiles.appId, id));
      const list =
        others.length === 0
          ? "<p>No files are stored for this app yet.</p>"
          : "<p>Files stored:</p><ul>" +
            others.map((o) => `<li><code>${o.path}</code></li>`).join("") +
            "</ul>";
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>" +
          "<body style=\"font-family:sans-serif;padding:2rem;color:#666;min-height:100dvh;margin:0\">" +
          "<p>This app doesn't have an <code>index.html</code> yet.</p>" +
          list +
          "<p>Ask Forge again: <em>make an app that says hi</em></p>" +
          "</body></html>",
      );
      return;
    }
    res.status(404).send("Not found");
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", getMimeType(path));
  let body = file.content;
  if (path === "index.html" || path.endsWith(".html")) {
    const base = baseHref ?? `/api/forge/preview/${id}/`;
    body = injectPreviewPolish(body, base);
  }
  res.send(body);
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

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

async function serveIndex(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const baseHref = `/api/forge/preview/${id}/`;
  await serveFile(id, "index.html", res, baseHref);
}

router.get("/:id", serveIndex);
router.get("/:id/", serveIndex);

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

router.get("/:id/*splat", async (req, res) => {
  const id = Number(req.params.id);
  const path = joinSplat((req.params as Record<string, unknown>).splat) || "index.html";
  await serveFile(id, path, res, `/api/forge/preview/${id}/`);
});

export default router;
