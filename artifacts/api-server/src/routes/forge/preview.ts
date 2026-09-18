import { Router, type IRouter, type Request, type Response } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname, resolve, extname } from "path";
import { fileURLToPath } from "url";
import { db, conversations, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { executeBackendHandler } from "./sandbox";
import { signup, login, getSessionUser, destroySession } from "./forge-accounts";

const router: IRouter = Router();

/** Instant Axis shell — zero disk I/O, zero Vite. */
const AXIS_STATIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Axis</title>
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;min-height:100%;min-height:100dvh;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827}
    .wrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
    .card{text-align:center;max-width:28rem}
    h1{margin:0;font-size:1.75rem;font-weight:700;letter-spacing:-0.02em}
    p{margin:.75rem 0 0;font-size:.95rem;color:#4b5563;line-height:1.5}
    .badge{display:inline-block;margin-top:1.25rem;padding:.35rem .75rem;border-radius:999px;background:#111827;color:#f9fafb;font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
  </style>
</head>
<body>
  <div class="wrap"><div class="card">
    <h1>Axis</h1>
    <p>Your app will appear here once it&rsquo;s ready.</p>
    <span class="badge">Forge preview</span>
  </div></div>
</body>
</html>`;

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

let cachedRoot: string | null | undefined;
let cachedDist: string | null | undefined;

function findMonorepoRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
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
          if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
            cachedRoot = dir;
            return dir;
          }
          if (existsSync(join(dir, "artifacts", "axis-preview", "package.json"))) {
            cachedRoot = dir;
            return dir;
          }
        } catch {
          /* ignore */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cachedRoot = null;
  return null;
}

function findAxisPreviewDist(): string | null {
  if (cachedDist !== undefined) return cachedDist;
  const root = findMonorepoRoot();
  if (!root) {
    cachedDist = null;
    return null;
  }
  for (const rel of [
    "artifacts/axis-preview/dist/public",
    "artifacts/axis-preview/dist",
    "artifacts/axis-preview/forge-static",
  ]) {
    const dir = join(root, rel);
    if (existsSync(join(dir, "index.html"))) {
      cachedDist = dir;
      return dir;
    }
  }
  cachedDist = null;
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
  if (Number.isNaN(id) || id <= 0) return false;
  try {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    return !!conv && conv.source === "forge";
  } catch {
    return false;
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

function sendAxisStatic(res: Response, baseHref: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(injectPreviewPolish(AXIS_STATIC_HTML, baseHref));
}

async function serveFile(id: number, path: string, res: Response, baseHref?: string): Promise<void> {
  const base = baseHref ?? `/api/forge/preview/${id}/`;

  // Fast path for index: always return embedded Axis page immediately.
  // (Full Vite dist is optional and only used for non-index assets if present.)
  if (path === "index.html" || path === "" || path === "/") {
    // Try disk Vite dist first (if user built it)
    const disk = findAxisPreviewDist();
    if (disk && !/forge-static/i.test(disk)) {
      if (tryServeFromDisk(disk, "index.html", res, base)) return;
    }
    // Instant embedded page — never hang
    sendAxisStatic(res, base);
    return;
  }

  if (!(await isForgeApp(id))) {
    res.status(404).send("App not found");
    return;
  }

  const disk = findAxisPreviewDist();
  if (disk && tryServeFromDisk(disk, path, res, base)) return;

  try {
    const [file] = await db
      .select()
      .from(forgeAppFiles)
      .where(and(eq(forgeAppFiles.appId, id), eq(forgeAppFiles.path, path)));

    if (file) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", getMimeType(path));
      let body = file.content;
      if (path.endsWith(".html")) body = injectPreviewPolish(body, base);
      res.send(body);
      return;
    }
  } catch {
    /* ignore */
  }

  res.status(404).send("Not found");
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
