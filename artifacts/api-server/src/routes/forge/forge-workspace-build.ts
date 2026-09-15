/**
 * Build a Vite/React package from the local Axis monorepo (where Forge runs)
 * and load the dist output into forgeAppFiles for static preview.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { spawn } from "child_process";
import { db, forgeAppFiles } from "@workspace/db";
import { eq } from "drizzle-orm";

const TEXT_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "svg", "txt", "map", "xml", "woff", "woff2",
]);

function findMonorepoRoot(): string | null {
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    candidates.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const envKey of ["REPL_HOME", "HOME"]) {
    const v = process.env[envKey];
    if (v) candidates.push(v, join(v, "workspace"));
  }
  candidates.push("/home/runner/workspace", "/home/runner");

  for (const c of candidates) {
    try {
      if (c && existsSync(join(c, "pnpm-workspace.yaml"))) return c;
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
): Promise<{ code: number; stdout: string; stderr: string }> {
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
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
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
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

function walkFiles(dir: string, base = dir): string[] {
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
      results.push(...walkFiles(full, base));
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

async function loadDistIntoApp(appId: number, distDir: string): Promise<{ files: number; paths: string[] }> {
  await db.delete(forgeAppFiles).where(eq(forgeAppFiles.appId, appId));

  const all = walkFiles(distDir);
  let files = 0;
  const paths: string[] = [];
  for (const full of all) {
    const rel = relative(distDir, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue;
    const ext = rel.includes(".") ? rel.split(".").pop()!.toLowerCase() : "";
    if (!TEXT_EXTS.has(ext) && ext !== "") {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (content.length > 1_500_000) continue;
    await db.insert(forgeAppFiles).values({ appId, path: rel, content });
    files++;
    paths.push(rel);
  }
  return { files, paths: paths.slice(0, 30) };
}

export type BuildResult =
  | { ok: true; package: string; distDir: string; files: number; paths: string[] }
  | { ok: false; error: string; packages?: string[] };

/**
 * Build a frontend package from the local monorepo and load dist into this Forge app.
 * packageHint: optional filter like "axis-preview" or "@workspace/axis-preview"
 */
export async function buildWorkspacePackage(
  appId: number,
  packageHint?: string,
): Promise<BuildResult> {
  const root = findMonorepoRoot();
  if (!root) {
    return {
      ok: false,
      error:
        "Could not find the Axis monorepo on disk (no pnpm-workspace.yaml). Forge can only build packages when running inside the Axis Repl.",
    };
  }

  const packages = listFrontendPackages(root);
  if (packages.length === 0) {
    return { ok: false, error: "No frontend packages found under artifacts/." };
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
        error: `No package matching "${packageHint}". Available: ${packages.map((p) => p.relativeDir).join(", ")}`,
        packages: packages.map((p) => p.relativeDir),
      };
    }
    target = match;
  }

  const basePath = `/api/forge/preview/${appId}/`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: process.env.PORT || "5000",
    BASE_PATH: basePath,
    NODE_ENV: "production",
  };

  const build = await runCommand(
    "pnpm",
    ["--filter", target.name, "run", "build"],
    { cwd: root, env, timeoutMs: 240_000 },
  );

  if (build.code !== 0) {
    const local = await runCommand("pnpm", ["run", "build"], {
      cwd: target.dir,
      env,
      timeoutMs: 240_000,
    });
    if (local.code !== 0) {
      const errTail = (local.stderr || build.stderr || local.stdout || build.stdout).slice(-1500);
      return {
        ok: false,
        error: `Build failed for ${target.relativeDir}. ${errTail || "Unknown error"}`,
        packages: packages.map((p) => p.relativeDir),
      };
    }
  }

  const distDir = findDistDir(target.dir);
  if (!distDir) {
    return {
      ok: false,
      error: `Build finished but no dist/index.html found under ${target.relativeDir}.`,
      packages: packages.map((p) => p.relativeDir),
    };
  }

  const loaded = await loadDistIntoApp(appId, distDir);
  if (loaded.files === 0) {
    return {
      ok: false,
      error: `Dist at ${distDir} had no loadable text assets.`,
    };
  }

  return {
    ok: true,
    package: target.relativeDir,
    distDir,
    files: loaded.files,
    paths: loaded.paths,
  };
}

export function describeMonorepo(): { root: string | null; packages: WorkspacePackage[] } {
  const root = findMonorepoRoot();
  return { root, packages: root ? listFrontendPackages(root) : [] };
}
