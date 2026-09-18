import { Router, type IRouter, type Request, type Response } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname, resolve, extname } from "path";
import { fileURLToPath } from "url";
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
  map: "application/json",
  woff: "font/woff",
  woff2: "font/woff2",
};

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function joinSplat(splat: unknown): string {
  if (Array.isArray(splat)) return splat.join("/");
  return typeof splat === "string" ? splat : "";
}

function findMonorepoRoot(): string | null {
  const candidates: string[] = [];
  const add = (p?: string | null) => {
    if (!p) return;
    try {
      candidates.push(resolve(p));
    } catch {
      /* ignore */
    }
  };
  add(process.cwd());
  try {
    const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
    add(here);
  } catch {
    /* ignore */
  }
  for (const k of ["REPL_HOME", "HOME", "PWD"]) {
    add(process.env[k]);
    if (process.env[k]) add(join(process.env[k]!, "workspace"));
  }
  add("/home/runner/workspace");
  add("/home/runner");
  add("/workspace");

  const seen = new Set<string>();
  for (const seed of candidates) {
    let dir = seed;
    for (let i = 0; i < 14; i++) {
      if (!seen.has(dir)) {
        seen.add(dir);
        try {
          if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
          if (existsSync(join(dir, "artifacts", "axis-preview", "package.json"))) return dir;
        } catch {
          /* ignore */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Prefer full Vite dist; otherwise instant forge-static (no build). */
function findAxisPreviewDist(): string | null {
  const root = findMonorepoRoot();
  if (!root) return null;
  for (const rel of [
    "artifacts/axis-preview/dist/public",
    "artifacts/axis-preview/dist",
    "artifacts/axis-preview/forge-static",
  ]) {
    const dir = join(root, rel);
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

function injectPreviewPolish(html: string, baseHref: string): string {
  let out = html;

  if (!/<base\s/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    } else {
      out = `<!doctype html><html><head><base href="${baseHref}"></head><body>${out}</body></html>`;
    }
  } else {
    out = out.replace(/<base\s+[^>]*>/i, `<base href="${baseHref}">`);
  }

  if (!/<meta[^>]+name=["']viewport["']/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">`,
    );
  }

  const fillCss =
    `<style id="forge-preview-fill">` +
    `html,body{width:100%;height:100%;min-height:100%;min-height:100dvh;margin:0;padding:0;}` +
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

async function appWantsAxisDisk(id: number): Promise<boolean> {
  try {
    const [marker] = await db
      .select()
      .from(forgeAppFiles)
      .where(and(eq(forgeAppFiles.appId, id), eq(forgeAppFiles.path, "index.html")));
    if (!marker?.content) return true;
    if (/forge-disk:axis-preview/i.test(marker.content)) return true;
    if (/artifacts\/axis-preview/i.test(marker.content)) return true;
    if (/\/assets\//.test(marker.content) && /type=["']module["']/.test(marker.content)) {
      return !!findAxisPreviewDist();
    }
    // Always allow disk/static for empty-ish or Axis pulls
    return true;
  } catch {
    return true;
  }
}

function tryServeFromDisk(distDir: string, path: string, res: Response, baseHref: string): boolean {
  const safe = path.replace(/^\/+/, "").replace(/\\/g, "/");
  if (safe.includes("..")) return false;
  const full = join(distDir, safe || "index.html");
  if (!existsSync(full)) return false;
  try {
    if (!statSync(full).isFile()) return false;
  } catch {
    return false;
  }

  const ext = extname(full).slice(1).toLowerCase();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", getMimeType(safe || "index.html"));

  if (ext === "html" || safe === "index.html" || !safe) {
    let body = readFileSync(full, "utf8");
    body = injectPreviewPolish(body, baseHref);
    body = body.replace(/(href|src)=(["'])\/assets\//g, `$1=$2${baseHref}assets/`);
    res.send(body);
  } else if (["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2"].includes(ext)) {
    res.send(readFileSync(full));
  } else {
    res.send(readFileSync(full, "utf8"));
  }
  return true;
}

async function serveFile(id: number, path: string, res: Response, baseHref?: string): Promise<void> {
  if (!(await isForgeApp(id))) {
    res.status(404).send("App not found");
    return;
  }

  const base = baseHref ?? `/api/forge/preview/${id}/`;
  const disk = findAxisPreviewDist();

  if (disk && (await appWantsAxisDisk(id))) {
    const served = tryServeFromDisk(disk, path === "" ? "index.html" : path, res, base);
    if (served) return;
  }

  const [file] = await db
    .select()
    .from(forgeAppFiles)
    .where(and(eq(forgeAppFiles.appId, id), eq(forgeAppFiles.path, path)));

  if (!file) {
    if (path === "index.html") {
      if (disk && tryServeFromDisk(disk, "index.html", res, base)) return;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>" +
          "<body style=\"font-family:sans-serif;padding:2rem;min-height:100dvh;margin:0\">" +
          "<p>No preview yet. Say <strong>pull</strong> after <code>git pull</code>.</p>" +
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
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result);
    return;
  }

  if (route === "/_auth/login" && req.method === "POST") {
    const result = await login(appId, String(body.email ?? ""), String(body.password ?? ""));
    if ("error" in result) {
      res.status(401).json({ error: result.error });
      return;
    }
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
  await serveFile(id, "index.html", res, `/api/forge/preview/${id}/`);
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
