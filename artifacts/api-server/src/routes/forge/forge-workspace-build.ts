/**
 * Load a Vite/React package into forgeAppFiles for static preview.
 *
 * Hard rule: the HTTP request path must finish in ~15s. A full axis-preview
 * Vite build can take minutes — so by default we ONLY reuse an existing dist.
 * Cold compile is opt-in (forceCompile) with a 12s kill switch.
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

const distCache = new Map<string, { distDir: string; at: number }>();
const DIST_CACHE_MS = 30 * 60 * 1000;

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
    }, opts.timeoutMs ?? 12_000);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 80_000) stdout = stdout.slice(-40_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 80_000) stderr = stderr.slice(-40_000);
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
    if (/assets\//i.test(html) && /\.js/i.test(html)) return true;
    if (/type=["']module["']/i.test(html) && !/src\/main/i.test(html)) return true;
    return false;
  } catch {
    return false;
  }
}

function rewritePreviewBase(content: string, path: string, basePath: string): string {
  let out = content;
  out = out.replace(/\/api\/forge\/preview\/\d+\//g, basePath);
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

  const chunk = 50;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(forgeAppFiles).values(rows.slice(i, i + chunk));
  }

  return { files: rows.length, paths: paths.slice(0, 40), indexPreview };
}

function pickPackage(packages: WorkspacePackage[], packageHint?: string): WorkspacePackage | null {
  if (!packages.length) return null;
  if (!packageHint?.trim()) return packages[0];
  const h = packageHint.trim().toLowerCase();
  return (
    packages.find(
      (p) =>
        p.name.toLowerCase().includes(h) ||
        p.relativeDir.toLowerCase().includes(h) ||
        p.relativeDir.split("/").pop()?.toLowerCase() === h,
    ) ?? null
  );
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

/**
 * Load package for Forge preview. Default = dist-only (seconds).
 * Set forceCompile=true only for explicit rebuild attempts (12s max).
 */
export async function buildWorkspacePackage(
  appId: number,
  packageHint?: string,
  opts?: { forceCompile?: boolean },
): Promise<BuildResult> {
  const started = Date.now();
  const forceCompile = !!opts?.forceCompile;
  const root = findMonorepoRoot();
  if (!root) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root: null,
      error: `Could not find Axis monorepo (no pnpm-workspace.yaml). cwd=${process.cwd()}.`,
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

  const target = pickPackage(packages, packageHint);
  if (!target) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `No package matching "${packageHint}". Available: ${packages.map((p) => p.relativeDir).join(", ")}`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const basePath = `/api/forge/preview/${appId}/`;

  // Always try cache + disk first (target: under 1–3s)
  const tryLoad = async (distDir: string, reused: boolean): Promise<BuildResult | null> => {
    if (!distLooksBuilt(distDir)) return null;
    const loaded = await loadDistIntoApp(appId, distDir, basePath);
    if (loaded.files === 0) return null;
    distCache.set(target.dir, { distDir, at: Date.now() });
    return {
      ok: true,
      package: target.relativeDir,
      distDir,
      files: loaded.files,
      paths: loaded.paths,
      buildMs: Date.now() - started,
      indexLooksBuilt: true,
      reusedDist: reused,
    };
  };

  const cached = distCache.get(target.dir);
  if (cached && Date.now() - cached.at < DIST_CACHE_MS) {
    const hit = await tryLoad(cached.distDir, true);
    if (hit) return hit;
  }

  const existingDist = findDistDir(target.dir);
  if (existingDist) {
    const hit = await tryLoad(existingDist, true);
    if (hit) return hit;
  }

  // No dist — do NOT hang on a multi-minute Vite build during chat
  if (!forceCompile) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error:
        `No built dist for ${target.relativeDir} yet. In the Replit shell run once:\n` +
        `  cd ${target.relativeDir} && pnpm run build\n` +
        `Then say pull / build again — loading dist takes a few seconds (not minutes).`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  // Opt-in cold compile with hard 12s limit
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: process.env.PORT || "5000",
    BASE_PATH: "./",
    NODE_ENV: "production",
    FORGE_FAST_BUILD: "1",
  };

  const viteBin = join(target.dir, "node_modules", ".bin", "vite");
  const rootViteBin = join(root, "node_modules", ".bin", "vite");
  const cmd = existsSync(viteBin) ? viteBin : existsSync(rootViteBin) ? rootViteBin : null;

  let build: { code: number; stdout: string; stderr: string; ms: number };
  if (cmd) {
    build = await runCommand(cmd, ["build", "--config", "vite.config.ts", "--logLevel", "error"], {
      cwd: target.dir,
      env,
      timeoutMs: 12_000,
    });
  } else {
    build = await runCommand(
      "pnpm",
      ["exec", "vite", "build", "--config", "vite.config.ts", "--logLevel", "error"],
      { cwd: target.dir, env, timeoutMs: 12_000 },
    );
  }

  if (build.code !== 0) {
    const errTail = (build.stderr || build.stdout || "").slice(-1200);
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error:
        build.code === 124
          ? `Vite cannot finish ${target.relativeDir} in 12s. Run in shell: cd ${target.relativeDir} && pnpm run build — then pull again (instant).`
          : `Build failed (${build.ms}ms): ${errTail || "non-zero exit"}`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const distDir = findDistDir(target.dir);
  if (!distDir) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Build exited 0 but no dist/index.html under ${target.relativeDir}.`,
    };
  }

  const hit = await tryLoad(distDir, false);
  if (hit) return hit;

  return {
    ok: false,
    buildMs: Date.now() - started,
    root,
    error: `Dist at ${distDir} could not be loaded into the app.`,
  };
}

export function describeMonorepo(): { root: string | null; packages: WorkspacePackage[] } {
  const root = findMonorepoRoot();
  return { root, packages: root ? listFrontendPackages(root) : [] };
}
