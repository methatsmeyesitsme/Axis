/**
 * Build a Vite/React package from the local Axis monorepo and load dist into
 * forgeAppFiles for static preview.
 *
 * Speed strategy:
 * 1. Reuse existing dist (rewrite base) — near-instant
 * 2. One fast vite build (FORGE_FAST_BUILD, no minify, 45s timeout)
 * 3. Never chain three 180s builds (that felt like "minutes / never finishes")
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { db, forgeAppFiles } from "@workspace/db";
import { eq } from "drizzle-orm";

const TEXT_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "svg", "txt", "map", "xml",
]);

/** In-process cache: package dir → last successful dist path */
const distCache = new Map<string, { distDir: string; at: number }>();
const DIST_CACHE_MS = 10 * 60 * 1000;

function findMonorepoRoot(): string | null {
  const candidates: string[] = [];
  const seeds = [process.cwd()];
  try {
    const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
    seeds.push(here);
  } catch {
    /* ignore */
  }
  for (const seed of seeds) {
    let dir = seed;
    for (let i = 0; i < 12; i++) {
      candidates.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const envKey of ["REPL_HOME", "HOME", "PWD"]) {
    const v = process.env[envKey];
    if (v) {
      candidates.push(v);
      candidates.push(join(v, "workspace"));
    }
  }
  candidates.push("/home/runner/workspace", "/home/runner", "/home/user/workspace", "/workspace");

  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      if (existsSync(join(c, "pnpm-workspace.yaml"))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export type WorkspacePackage = {
  dir: string;
  name: string;
  relativeDir: string;
  hasVite: boolean;
  hasBuild: boolean;
};

export function listFrontendPackages(root: string): WorkspacePackage[] {
  const artifacts = join(root, "artifacts");
  if (!existsSync(artifacts)) return [];
  const out: WorkspacePackage[] = [];
  for (const name of readdirSync(artifacts)) {
    const dir = join(artifacts, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg: { name?: string; scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const hasVite =
      existsSync(join(dir, "vite.config.ts")) ||
      existsSync(join(dir, "vite.config.js")) ||
      existsSync(join(dir, "index.html"));
    const hasBuild = !!pkg.scripts?.build;
    if (!hasVite && !hasBuild) continue;
    if (name === "api-server") continue;
    out.push({
      dir,
      name: pkg.name || name,
      relativeDir: `artifacts/${name}`,
      hasVite,
      hasBuild,
    });
  }
  const rank = (p: WorkspacePackage) => {
    if (/axis-preview/.test(p.relativeDir)) return 0;
    if (/tidy-toters/.test(p.relativeDir)) return 1;
    if (/mockup-sandbox/.test(p.relativeDir)) return 2;
    return 5;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return out;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]", ms: Date.now() - started });
    }, opts.timeoutMs ?? 45_000);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 100_000) stdout = stdout.slice(-50_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err), ms: Date.now() - started });
    });
  });
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function findDistDir(pkgDir: string): string | null {
  for (const candidate of [join(pkgDir, "dist", "public"), join(pkgDir, "dist"), join(pkgDir, "build")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

function distLooksBuilt(distDir: string): boolean {
  try {
    const html = readFileSync(join(distDir, "index.html"), "utf8");
    if (/\/src\/main\.(tsx|jsx|ts|js)/i.test(html)) return false;
    // Has hashed assets or at least a module script that is not source
    if (/assets\//i.test(html) && /\.js/i.test(html)) return true;
    if (/type=["']module["']/i.test(html) && !/src\/main/i.test(html)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Relative base so one dist works for every forge app id without rebuild. */
function rewritePreviewBase(content: string, path: string, basePath: string): string {
  let out = content;
  out = out.replace(/\/api\/forge\/preview\/\d+\//g, basePath);
  // Absolute /assets → relative under base
  if (path === "index.html" || path.endsWith(".html")) {
    out = out.replace(/(href|src)=(["'])\/assets\//g, `$1=$2${basePath}assets/`);
    if (/<base\s/i.test(out)) {
      out = out.replace(/<base\s+[^>]*>/i, `<base href="${basePath}">`);
    } else if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`);
    }
  }
  return out;
}

async function loadDistIntoApp(
  appId: number,
  distDir: string,
  basePath: string,
): Promise<{ files: number; paths: string[]; indexPreview: string }> {
  await db.delete(forgeAppFiles).where(eq(forgeAppFiles.appId, appId));

  const all = walkFiles(distDir);
  const rows: { appId: number; path: string; content: string }[] = [];
  let indexPreview = "";
  const paths: string[] = [];

  for (const full of all) {
    const rel = relative(distDir, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue;
    const ext = rel.includes(".") ? rel.split(".").pop()!.toLowerCase() : "";
    if (ext && !TEXT_EXTS.has(ext)) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (content.length > 1_500_000) continue;
    content = rewritePreviewBase(content, rel, basePath);
    rows.push({ appId, path: rel, content });
    paths.push(rel);
    if (rel === "index.html") indexPreview = content.slice(0, 400);
  }

  const chunk = 40;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(forgeAppFiles).values(rows.slice(i, i + chunk));
  }

  return { files: rows.length, paths: paths.slice(0, 40), indexPreview };
}

export type BuildResult =
  | {
      ok: true;
      package: string;
      distDir: string;
      files: number;
      paths: string[];
      buildMs: number;
      indexLooksBuilt: boolean;
      reusedDist?: boolean;
    }
  | { ok: false; error: string; packages?: string[]; buildMs?: number; root?: string | null };

export async function buildWorkspacePackage(
  appId: number,
  packageHint?: string,
): Promise<BuildResult> {
  const started = Date.now();
  const root = findMonorepoRoot();
  if (!root) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root: null,
      error:
        "Could not find the Axis monorepo on disk (no pnpm-workspace.yaml near the server). " +
        `cwd=${process.cwd()}.`,
    };
  }

  const packages = listFrontendPackages(root);
  if (packages.length === 0) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `No frontend packages under ${root}/artifacts/.`,
    };
  }

  let target = packages[0];
  if (packageHint?.trim()) {
    const h = packageHint.trim().toLowerCase();
    const match = packages.find(
      (p) =>
        p.name.toLowerCase().includes(h) ||
        p.relativeDir.toLowerCase().includes(h) ||
        p.relativeDir.split("/").pop()?.toLowerCase() === h,
    );
    if (!match) {
      return {
        ok: false,
        buildMs: Date.now() - started,
        root,
        error: `No package matching "${packageHint}". Available: ${packages.map((p) => p.relativeDir).join(", ")}`,
        packages: packages.map((p) => p.relativeDir),
      };
    }
    target = match;
  }

  const basePath = `/api/forge/preview/${appId}/`;

  // 1) Memory cache
  const cached = distCache.get(target.dir);
  if (cached && Date.now() - cached.at < DIST_CACHE_MS && distLooksBuilt(cached.distDir)) {
    const loaded = await loadDistIntoApp(appId, cached.distDir, basePath);
    if (loaded.files > 0) {
      return {
        ok: true,
        package: target.relativeDir,
        distDir: cached.distDir,
        files: loaded.files,
        paths: loaded.paths,
        buildMs: Date.now() - started,
        indexLooksBuilt: true,
        reusedDist: true,
      };
    }
  }

  // 2) Disk dist already present
  const existingDist = findDistDir(target.dir);
  if (existingDist && distLooksBuilt(existingDist)) {
    distCache.set(target.dir, { distDir: existingDist, at: Date.now() });
    const loaded = await loadDistIntoApp(appId, existingDist, basePath);
    if (loaded.files > 0) {
      return {
        ok: true,
        package: target.relativeDir,
        distDir: existingDist,
        files: loaded.files,
        paths: loaded.paths,
        buildMs: Date.now() - started,
        indexLooksBuilt: true,
        reusedDist: true,
      };
    }
  }

  // 3) One fast Vite build only (relative base → reusable)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: process.env.PORT || "5000",
    BASE_PATH: "./",
    NODE_ENV: "production",
    FORGE_FAST_BUILD: "1",
  };

  // Prefer node_modules/.bin/vite if present (avoids slow pnpm resolve)
  const viteBin = join(target.dir, "node_modules", ".bin", "vite");
  const rootViteBin = join(root, "node_modules", ".bin", "vite");
  let build: { code: number; stdout: string; stderr: string; ms: number };

  if (existsSync(viteBin)) {
    build = await runCommand(viteBin, ["build", "--config", "vite.config.ts", "--logLevel", "error"], {
      cwd: target.dir,
      env,
      timeoutMs: 45_000,
    });
  } else if (existsSync(rootViteBin)) {
    build = await runCommand(rootViteBin, ["build", "--config", "vite.config.ts", "--logLevel", "error"], {
      cwd: target.dir,
      env,
      timeoutMs: 45_000,
    });
  } else {
    build = await runCommand(
      "pnpm",
      ["exec", "vite", "build", "--config", "vite.config.ts", "--logLevel", "error"],
      { cwd: target.dir, env, timeoutMs: 45_000 },
    );
  }

  if (build.code !== 0) {
    const errTail = (build.stderr || build.stdout || "").slice(-1500);
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error:
        build.code === 124
          ? `Build timed out after ${build.ms}ms for ${target.relativeDir}. Run once in the shell: cd ${target.relativeDir} && pnpm run build — then pull again to reuse dist.`
          : `Build failed for ${target.relativeDir} (${build.ms}ms). ${errTail || "vite exited non-zero"}`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const distDir = findDistDir(target.dir);
  if (!distDir || !distLooksBuilt(distDir)) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Build finished (${build.ms}ms) but dist is missing or still a source shell under ${target.relativeDir}.`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  distCache.set(target.dir, { distDir, at: Date.now() });
  const loaded = await loadDistIntoApp(appId, distDir, basePath);
  if (loaded.files === 0) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Dist at ${distDir} had no loadable text assets.`,
    };
  }

  return {
    ok: true,
    package: target.relativeDir,
    distDir,
    files: loaded.files,
    paths: loaded.paths,
    buildMs: Date.now() - started,
    indexLooksBuilt: true,
    reusedDist: false,
  };
}

export function describeMonorepo(): { root: string | null; packages: WorkspacePackage[] } {
  const root = findMonorepoRoot();
  return { root, packages: root ? listFrontendPackages(root) : [] };
}
