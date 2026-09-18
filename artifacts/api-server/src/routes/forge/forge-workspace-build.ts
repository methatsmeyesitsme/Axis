/**
 * Build a Vite/React package from the local Axis monorepo (where Forge runs)
 * and load the dist output into forgeAppFiles for static preview.
 *
 * Speed: prefer an already-built dist (rewrite asset base for this app id)
 * instead of running a full Vite build every pull/preview.
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
    }, opts.timeoutMs ?? 180_000);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
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
  for (const candidate of [join(pkgDir, "dist", "public"), join(pkgDir, "dist")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True if dist index looks like a real Vite production build (not /src/main.tsx shell). */
function distLooksBuilt(distDir: string): boolean {
  try {
    const html = readFileSync(join(distDir, "index.html"), "utf8");
    if (/\/src\/main\.(tsx|jsx|ts|js)/i.test(html)) return false;
    return /\/assets\//i.test(html) || /type=["']module["']/i.test(html);
  } catch {
    return false;
  }
}

/** Point absolute preview bases at this app's preview URL. */
function rewritePreviewBase(content: string, path: string, basePath: string): string {
  let out = content;
  // Any previous forge preview base → this app
  out = out.replace(/\/api\/forge\/preview\/\d+\//g, basePath);
  if (path === "index.html" || path.endsWith(".html")) {
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
  let files = 0;
  const paths: string[] = [];
  let indexPreview = "";
  const rows: { appId: number; path: string; content: string }[] = [];

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
    files++;
    paths.push(rel);
    if (rel === "index.html") indexPreview = content.slice(0, 400);
  }

  // Batch insert in chunks for speed
  const chunk = 25;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(forgeAppFiles).values(rows.slice(i, i + chunk));
  }

  return { files, paths: paths.slice(0, 40), indexPreview };
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
        `cwd=${process.cwd()}. Forge builds only work when the API server runs inside the Axis Repl.`,
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

  // Fast path: reuse existing production dist (ButtonPresser-speed after first build)
  const existingDist = findDistDir(target.dir);
  if (existingDist && distLooksBuilt(existingDist)) {
    const loaded = await loadDistIntoApp(appId, existingDist, basePath);
    if (loaded.files > 0 && loaded.indexPreview) {
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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: process.env.PORT || "5000",
    BASE_PATH: basePath,
    NODE_ENV: "production",
  };

  // Prefer local vite in the package dir (faster than workspace filter resolve)
  let build = await runCommand(
    "pnpm",
    ["exec", "vite", "build", "--config", "vite.config.ts", "--logLevel", "error"],
    { cwd: target.dir, env, timeoutMs: 180_000 },
  );

  if (build.code !== 0) {
    build = await runCommand("pnpm", ["run", "build"], {
      cwd: target.dir,
      env,
      timeoutMs: 180_000,
    });
  }

  if (build.code !== 0) {
    build = await runCommand("pnpm", ["--filter", target.name, "run", "build"], {
      cwd: root,
      env,
      timeoutMs: 180_000,
    });
  }

  if (build.code !== 0) {
    const errTail = (build.stderr || build.stdout || "").slice(-2000);
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Build failed for ${target.relativeDir} (${build.ms}ms). ${errTail || "pnpm/vite exited non-zero"}`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const distDir = findDistDir(target.dir);
  if (!distDir) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Build reported success (${build.ms}ms) but no dist/index.html under ${target.relativeDir}.`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const loaded = await loadDistIntoApp(appId, distDir, basePath);
  if (loaded.files === 0) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error: `Dist at ${distDir} had no loadable text assets.`,
    };
  }

  const indexLooksBuilt =
    !!loaded.indexPreview &&
    !/\/src\/main\.(tsx|jsx|ts|js)/i.test(loaded.indexPreview) &&
    (/\/assets\//i.test(loaded.indexPreview) || /type=["']module["']/i.test(loaded.indexPreview));

  if (!indexLooksBuilt && /\/src\/main\.(tsx|jsx)/i.test(loaded.indexPreview)) {
    return {
      ok: false,
      buildMs: Date.now() - started,
      root,
      error:
        `Loaded ${loaded.files} files from ${distDir}, but index.html still points at /src/main.tsx — not a production build.`,
    };
  }

  return {
    ok: true,
    package: target.relativeDir,
    distDir,
    files: loaded.files,
    paths: loaded.paths,
    buildMs: Date.now() - started,
    indexLooksBuilt,
    reusedDist: false,
  };
}

export function describeMonorepo(): { root: string | null; packages: WorkspacePackage[] } {
  const root = findMonorepoRoot();
  return { root, packages: root ? listFrontendPackages(root) : [] };
}
