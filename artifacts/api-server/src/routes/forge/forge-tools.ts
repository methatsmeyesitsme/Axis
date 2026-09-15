import { db, forgeAppFiles, forgeAppData, forgeAppTables, forgeAppTableRows } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import type { FunctionDeclaration } from "@google/genai";
import { saveBackendHandler } from "./forge-handler-storage";
import { executeGithubTool, isGithubReady } from "../github-tools";
import { buildWorkspacePackage, describeMonorepo } from "./forge-workspace-build";

const summaryProp = {
  summary: { type: "string", description: "Concise past-tense summary of this action, 8 words maximum" },
};

export const forgeToolDeclarations: FunctionDeclaration[] = [
  {
    name: "write_file",
    description: "Create or overwrite a frontend file (HTML, CSS, or JS) for the app being built.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. index.html or style.css" },
        content: { type: "string", description: "Full file content" },
        ...summaryProp,
      },
      required: ["path", "content", "summary"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the app.",
    parametersJsonSchema: {
      type: "object",
      properties: { path: { type: "string" }, ...summaryProp },
      required: ["path", "summary"],
    },
  },
  {
    name: "import_github_repo",
    description:
      "Pull files from the user's connected GitHub repository into this Forge app so they can be previewed with the Run button. Copies text/web files (html, css, js, json, md, svg, txt). Prefer paths that include index.html when possible.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional subdirectory in the repo to import (e.g. 'docs' or 'public'). Leave empty for the whole repo root.",
        },
        ...summaryProp,
      },
      required: ["summary"],
    },
  },
  {
    name: "db_get",
    description: "Read a value from the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_set",
    description: "Write a value to the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string", description: "JSON-encoded value to store" },
        ...summaryProp,
      },
      required: ["key", "value", "summary"],
    },
  },
  {
    name: "db_delete",
    description: "Delete a key from the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_list",
    description: "List keys in the app's simple key/value storage, optionally filtered by prefix.",
    parametersJsonSchema: {
      type: "object",
      properties: { prefix: { type: "string" }, ...summaryProp },
      required: ["summary"],
    },
  },
  {
    name: "create_table",
    description:
      "Define a structured data table for the app. This is idempotent: inspect existing tables first, and if the table already exists, keep using it instead of trying to recreate it.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, type: { type: "string" } },
            required: ["name", "type"],
          },
        },
        ...summaryProp,
      },
      required: ["name", "columns", "summary"],
    },
  },
  {
    name: "table_list",
    description: "List the structured tables already defined for this app before creating or migrating one.",
    parametersJsonSchema: {
      type: "object",
      properties: { ...summaryProp },
      required: ["summary"],
    },
  },
  {
    name: "table_insert",
    description: "Insert a row into one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "string", description: "JSON-encoded object of column values" },
        ...summaryProp,
      },
      required: ["table", "data", "summary"],
    },
  },
  {
    name: "table_select",
    description: "Read rows from one of the app's tables, optionally filtered.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "Optional JSON-encoded object of exact-match filters" },
        ...summaryProp,
      },
      required: ["table", "summary"],
    },
  },
  {
    name: "table_update",
    description: "Update rows matching a filter in one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "JSON-encoded object of exact-match filters" },
        data: { type: "string", description: "JSON-encoded object of column values to set" },
        ...summaryProp,
      },
      required: ["table", "filter", "data", "summary"],
    },
  },
  {
    name: "table_delete",
    description: "Delete rows matching a filter in one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "JSON-encoded object of exact-match filters" },
        ...summaryProp,
      },
      required: ["table", "filter", "summary"],
    },
  },
  {
    name: "write_backend_handler",
    description:
      "Define real, executable backend logic for a route (e.g. POST /checkout). The code runs server-side in a sandbox with access to `req` (method, route, query, body) and `db` (get/set/delete/list, insert/select/update/deleteRows). It must `return { status, body }`.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method, e.g. GET, POST, PUT, DELETE" },
        route: { type: "string", description: "Route path, e.g. /checkout or /todos/:id" },
        code: {
          type: "string",
          description:
            "JavaScript statements (async allowed) using `req` and `db`, ending with `return { status: 200, body: ... }`",
        },
        ...summaryProp,
      },
      required: ["method", "route", "code", "summary"],
    },
  },
  {
    name: "add_accounts",
    description:
      "Enable sign-up/login accounts for the app's end users. Adds built-in endpoints (api/_auth/signup, api/_auth/login, api/_auth/logout, api/_auth/me) and makes the signed-in user available to write_backend_handler code as req.user.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
  {
    name: "build_workspace_app",
    description:
      "Build a Vite/React package from the local Axis monorepo (artifacts/*) and load the production dist into this Forge app for Run preview. Use for Axis, axis-preview, tidy-toters, mockup-sandbox, or when a GitHub pull only had SPA shells. Optional package name filter.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Optional package filter, e.g. axis-preview, tidy-toters, mockup-sandbox",
        },
        ...summaryProp,
      },
      required: ["summary"],
    },
  },
  {
    name: "run_preview",
    description:
      "Ensure the app has a root index.html (promoting a nested one if needed) and confirm the live preview is available via the Run button.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
];

export function truncateSummary(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  const words = text.split(/\s+/);
  return words.length > 8 ? words.slice(0, 8).join(" ") + "…" : text;
}

type ForgeToolResult = { output?: unknown; error?: string };

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = typeof (err as Error & { code?: unknown }).code === "string"
      ? ` [${(err as Error & { code: string }).code}]`
      : "";
    const cause = err.cause instanceof Error ? ` — caused by: ${err.cause.message}` : "";
    return `${err.message}${code}${cause}`;
  }
  return String(err);
}

function isAlreadyCompletedError(error: string): boolean {
  return /\b(already exists|duplicate key|duplicate table|relation .* already exists|duplicate object)\b/i.test(error);
}

function isTransientDatabaseError(error: string): boolean {
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated|connection reset|connection closed|server closed|deadlock detected|could not serialize|too many connections|connection is not available|timeout expired|temporarily unavailable)\b/i.test(error);
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const PREVIEW_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "md", "txt", "svg", "xml", "map",
]);

function isPreviewFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".")) return false;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return PREVIEW_EXTS.has(ext);
}

function isPlaceholderHtml(content: string): boolean {
  const c = content.toLowerCase();
  const stripped = c.replace(/\s+/g, " ");
  if (stripped.includes(">hi<") || stripped.includes(">hello<") || stripped.includes(">welcome to my web app<")) {
    if (content.length < 2500 && !/calendar|todo|counter|form|button|nav|grid|table/i.test(content)) return true;
  }
  if (/welcome to my web app/i.test(content) && content.length < 4000) return true;
  return false;
}

function isSpaShellHtml(content: string): boolean {
  const c = content.toLowerCase();
  if (!c.includes('id="root"') && !c.includes("id='root'")) return false;
  if (/type\s*=\s*["']module["']/.test(c) && /\.(tsx|jsx|ts|js)["']/.test(c)) return true;
  if (/src\s*=\s*["'][^"']*\/src\/main\.(tsx|jsx|ts|js)/.test(c)) return true;
  return false;
}

function spaLandingHtml(fromPath: string, allPaths: string[]): string {
  const pkg = fromPath.split("/")[1] || fromPath;
  const areas = Array.from(new Set(allPaths.map((p) => p.split("/")[0]).filter(Boolean))).slice(0, 10);
  const htmls = allPaths.filter((p) => p.endsWith(".html")).slice(0, 8);
  const areaList = areas.map((a) => `<code>${a}</code>`).join(", ") || "—";
  const htmlList = htmls.map((h) => `<code>${h}</code>`).join(", ");
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${pkg} — needs a build</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100dvh}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:1.5rem;line-height:1.5}
h1{font-size:1.35rem;margin:0 0 .5rem;color:#fff}
p{margin:.5rem 0;color:#94a3b8;font-size:.95rem}
code{background:#1e293b;padding:.15rem .4rem;border-radius:.35rem;font-size:.85rem;color:#93c5fd}
ul{margin:.75rem 0;padding-left:1.25rem;color:#cbd5e1}
li{margin:.25rem 0}
.box{background:#1e293b;border-radius:.75rem;padding:1rem 1.15rem;margin-top:1rem;border:1px solid #334155}
</style></head><body>
<h1>This package needs a full build</h1>
<p>Promoted <code>${fromPath}</code> — it is a <strong>Vite/React</strong> shell that loads <code>/src/main.tsx</code>.</p>
<p>Say <strong>build axis-preview</strong> to compile from the local monorepo and load the production dist into Run.</p>
<div class="box">
<p style="margin:0;color:#e2e8f0"><strong>What works in Forge</strong></p>
<ul>
<li><code>build axis-preview</code> / <code>build tidy-toters</code> (local monorepo Vite build)</li>
<li>Describe an app: <code>make a counter app</code>, <code>make a todo list</code></li>
<li>Self-contained HTML pages with inline CSS/JS</li>
</ul>
<p style="margin:0;color:#94a3b8;font-size:.85rem">Repo areas seen: ${areaList}</p>
${htmls.length ? `<p style="margin:.5rem 0 0;color:#94a3b8;font-size:.85rem">HTML files: ${htmlList}</p>` : ""}
</div>
</body></html>`;
}

async function ensureRootIndexHtml(
  appId: number,
  opts: { force?: boolean } = {},
): Promise<{ ok: true; from?: string } | { ok: false; files: string[] }> {
  const force = !!opts.force;
  const [root] = await db
    .select()
    .from(forgeAppFiles)
    .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, "index.html")));

  const all = await db.select().from(forgeAppFiles).where(eq(forgeAppFiles.appId, appId));
  const rank = (p: string): number => {
    const low = p.toLowerCase();
    if (low === "public/index.html" || low === "src/index.html") return 1;
    if (low.endsWith("/index.html") && /artifacts\/(tidy-toters|mockup-sandbox|axis-preview|codegen|preview)/i.test(low)) {
      if (/tidy-toters/.test(low)) return 1;
      return 2;
    }
    if (low.endsWith("/index.html")) return 3;
    if (low.endsWith(".html")) return 4;
    return 9;
  };
  const candidates = all
    .filter((f) => f.path !== "index.html" && (f.path.endsWith("/index.html") || f.path.endsWith(".html")))
    .filter((f) => f.content?.trim() && !isPlaceholderHtml(f.content))
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.length - b.path.length);
  const best = candidates[0];

  const rootOk = !!root?.content?.trim() && !isPlaceholderHtml(root.content) && !isSpaShellHtml(root.content);

  if (rootOk && !force) return { ok: true };
  if (rootOk && force && !best) return { ok: true };

  if (!best?.content?.trim()) {
    if (rootOk) return { ok: true };
    return { ok: false, files: all.map((f) => f.path).slice(0, 30) };
  }

  let contentToWrite = best.content;
  if (isSpaShellHtml(best.content)) {
    contentToWrite = spaLandingHtml(best.path, all.map((f) => f.path));
  }

  if (root) {
    await db
      .update(forgeAppFiles)
      .set({ content: contentToWrite, updatedAt: new Date() })
      .where(eq(forgeAppFiles.id, root.id));
  } else {
    await db.insert(forgeAppFiles).values({ appId, path: "index.html", content: contentToWrite });
  }
  return { ok: true, from: best.path };
}

async function importGithubIntoForge(
  appId: number,
  userId: number | null,
  rootPath: string,
): Promise<ForgeToolResult> {
  if (!userId) return { error: "Log in and connect GitHub in Settings first." };
  if (!(await isGithubReady(userId))) {
    return { error: "No GitHub repository is connected/selected. Connect GitHub and pick a repo in Settings." };
  }

  await db.delete(forgeAppFiles).where(eq(forgeAppFiles.appId, appId));

  const skipDir = (p: string) =>
    /(?:^|\/)(node_modules|\.git|\.agents|dist|build|\.next|coverage|\.turbo|\.cache|vendor)(?:\/|$)/i.test(p);

  const queue: string[] = [rootPath.replace(/^\/+/, "")];
  const filePaths: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && filePaths.length < 120) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (skipDir(dir)) continue;
    const listed = await executeGithubTool(userId, "github_list_files", { path: dir });
    if (listed.error) return { error: listed.error };
    const items = Array.isArray(listed.output) ? listed.output : [];
    for (const item of items as Array<{ path?: string; type?: string; name?: string }>) {
      const p = String(item.path ?? "");
      if (!p || skipDir(p)) continue;
      if (item.type === "dir") {
        queue.push(p);
      } else if (item.type === "file" && isPreviewFile(p)) {
        filePaths.push(p);
      }
    }
  }

  if (filePaths.length === 0) {
    return { error: "No previewable files found in that GitHub path (need html/css/js/json/md/svg/txt)." };
  }

  const rank = (p: string): number => {
    const low = p.toLowerCase();
    if (low === "index.html") return 0;
    if (low === "public/index.html" || low === "src/index.html") return 1;
    if (low.endsWith("/index.html") && /artifacts\/(tidy-toters|mockup-sandbox|axis-preview|codegen|preview)/i.test(low)) {
      if (/tidy-toters/.test(low)) return 1;
      return 2;
    }
    if (low.endsWith("/index.html")) return 3;
    if (low.endsWith(".html")) return 4;
    if (/\.(css|js|mjs)$/i.test(low)) return 5;
    if (/package\.json$/i.test(low) || /tsconfig/i.test(low)) return 9;
    return 6;
  };
  filePaths.sort((a, b) => rank(a) - rank(b) || a.length - b.length);

  let imported = 0;
  const names: string[] = [];

  for (const path of filePaths.slice(0, 50)) {
    const read = await executeGithubTool(userId, "github_read_file", { path });
    if (read.error || typeof read.output !== "string") continue;
    const content = read.output as string;
    if (content.length > 400_000) continue;
    await db.insert(forgeAppFiles).values({ appId, path, content });
    imported++;
    names.push(path);
  }

  const ensured = await ensureRootIndexHtml(appId, { force: true });
  let hasIndex = ensured.ok;
  let promoted = ensured.ok ? ensured.from ?? null : null;
  if (hasIndex && promoted && !names.includes("index.html")) names.unshift("index.html");

  const [rootFile] = await db
    .select()
    .from(forgeAppFiles)
    .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, "index.html")));
  const needsBuild =
    !rootFile?.content ||
    isSpaShellHtml(rootFile.content) ||
    /needs a full build|Vite\/React/i.test(rootFile.content);

  let built: { package?: string; files?: number } | null = null;
  if (needsBuild) {
    const buildResult = await buildWorkspacePackage(appId, "axis-preview");
    if (buildResult.ok) {
      hasIndex = true;
      promoted = buildResult.package;
      built = { package: buildResult.package, files: buildResult.files };
      names.unshift("index.html");
    } else {
      const fallback = await buildWorkspacePackage(appId);
      if (fallback.ok) {
        hasIndex = true;
        promoted = fallback.package;
        built = { package: fallback.package, files: fallback.files };
        names.unshift("index.html");
      }
    }
  }

  return {
    output: {
      imported,
      files: names.slice(0, 20),
      hasIndexHtml: hasIndex,
      promotedFrom: promoted,
      builtFromMonorepo: built,
      hint: built
        ? `Built ${built.package} from local monorepo (${built.files} files). Press Run to preview.`
        : hasIndex
          ? promoted
            ? `Promoted ${promoted} → index.html. Press Run to preview.`
            : "Preview is ready — user can press Run."
          : "Imported files, but no HTML entry. Say build axis-preview or make a simple app.",
    },
  };
}

async function executeForgeToolOnce(
  appId: number,
  name: string,
  rawArgs: Record<string, unknown>,
  userId?: number | null,
): Promise<ForgeToolResult> {
  try {
    switch (name) {
      case "write_file": {
        let path = String(rawArgs.path ?? "").trim().replace(/^\/+/, "");
        if (!path) path = "index.html";
        if (/^index\.hmtl$/i.test(path) || /^index\.htm$/i.test(path)) path = "index.html";
        const content = String(rawArgs.content ?? "");
        if (!content.trim()) return { error: "content is required — nothing was written" };
        const [existing] = await db
          .select()
          .from(forgeAppFiles)
          .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        if (existing) {
          await db.update(forgeAppFiles).set({ content, updatedAt: new Date() }).where(eq(forgeAppFiles.id, existing.id));
        } else {
          await db.insert(forgeAppFiles).values({ appId, path, content });
        }
        const [verify] = await db
          .select()
          .from(forgeAppFiles)
          .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        if (!verify || verify.content !== content) {
          return { error: `Failed to persist ${path} to the database. Restart the Repl and try again.` };
        }
        return { output: `Wrote ${path} (${content.length} bytes)` };
      }
      case "delete_file": {
        const path = String(rawArgs.path ?? "").trim().replace(/^\/+/, "");
        await db.delete(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        return { output: `Deleted ${path}` };
      }
      case "import_github_repo": {
        return importGithubIntoForge(appId, userId ?? null, String(rawArgs.path ?? ""));
      }
      case "db_get": {
        const key = String(rawArgs.key ?? "");
        const [row] = await db.select().from(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        return { output: row ? row.value : null };
      }
      case "db_set": {
        const key = String(rawArgs.key ?? "");
        const value = safeParseJson(rawArgs.value);
        const [existing] = await db.select().from(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        if (existing) {
          await db.update(forgeAppData).set({ value, updatedAt: new Date() }).where(eq(forgeAppData.id, existing.id));
        } else {
          await db.insert(forgeAppData).values({ appId, key, value });
        }
        return { output: "ok" };
      }
      case "db_delete": {
        const key = String(rawArgs.key ?? "");
        await db.delete(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        return { output: "ok" };
      }
      case "db_list": {
        const prefix = typeof rawArgs.prefix === "string" ? rawArgs.prefix : undefined;
        const rows = await db.select().from(forgeAppData).where(eq(forgeAppData.appId, appId));
        const keys = rows.map((r) => r.key).filter((k) => !prefix || k.startsWith(prefix));
        return { output: keys };
      }
      case "create_table": {
        const tableName = String(rawArgs.name ?? "").trim();
        const columns = safeParseJson(rawArgs.columns);
        if (!tableName) return { error: "name is required" };
        const [existing] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (existing) return { output: `Table ${tableName} already exists — continue using the existing table` };
        try {
          await db.insert(forgeAppTables).values({ appId, name: tableName, columns });
        } catch (err) {
          const message = errorText(err);
          if (isAlreadyCompletedError(message)) {
            const [racedExisting] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
            if (racedExisting) return { output: `Table ${tableName} already exists — continue using the existing table` };
          }
          throw err;
        }
        return { output: `Created table ${tableName}` };
      }
      case "table_list": {
        const tables = await db
          .select({ name: forgeAppTables.name, columns: forgeAppTables.columns })
          .from(forgeAppTables)
          .where(eq(forgeAppTables.appId, appId));
        return { output: tables };
      }
      case "table_insert": {
        const tableName = String(rawArgs.table ?? "").trim();
        const rowData = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist — create it first` };
        const [inserted] = await db.insert(forgeAppTableRows).values({ tableId: t.id, data: rowData }).returning();
        return { output: { id: inserted.id, ...(rowData as object) } };
      }
      case "table_select": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = rawArgs.filter ? (safeParseJson(rawArgs.filter) as Record<string, unknown>) : null;
        const rows =
          filterObj && Object.keys(filterObj).length > 0
            ? await db.select().from(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`))
            : await db.select().from(forgeAppTableRows).where(eq(forgeAppTableRows.tableId, t.id));
        return { output: rows.map((r) => ({ id: r.id, ...(r.data as Record<string, unknown>) })) };
      }
      case "table_update": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        const patch = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const rows = await db.select().from(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        for (const row of rows) {
          await db.update(forgeAppTableRows).set({ data: { ...(row.data as Record<string, unknown>), ...patch }, updatedAt: new Date() }).where(eq(forgeAppTableRows.id, row.id));
        }
        return { output: `Updated ${rows.length} row(s)` };
      }
      case "table_delete": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        const rows = await db.select().from(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        for (const row of rows) {
          await db.delete(forgeAppTableRows).where(eq(forgeAppTableRows.id, row.id));
        }
        return { output: `Deleted ${rows.length} row(s)` };
      }
      case "write_backend_handler": {
        const method = String(rawArgs.method ?? "GET").toUpperCase();
        const route = String(rawArgs.route ?? "");
        const code = String(rawArgs.code ?? "");
        if (!route || !code.trim()) return { error: "route and code are required" };
        await saveBackendHandler(appId, method, route, code);
        return { output: `Saved ${method} ${route}` };
      }
      case "add_accounts": {
        return { output: "Accounts enabled for this app" };
      }
      case "build_workspace_app": {
        const pkg = typeof rawArgs.package === "string" ? rawArgs.package : undefined;
        const result = await buildWorkspacePackage(appId, pkg);
        if (!result.ok) return { error: result.error };
        return {
          output: {
            package: result.package,
            files: result.files,
            paths: result.paths,
            hint: `Built ${result.package} (${result.files} files). Press Run to preview.`,
          },
        };
      }
      case "run_preview": {
        const ensured = await ensureRootIndexHtml(appId, { force: true });
        if (!ensured.ok) {
          const list = ensured.files.join(", ") || "(none)";
          return { error: `No index.html yet — files present: ${list}` };
        }
        return {
          output: ensured.from
            ? `Preview ready (promoted ${ensured.from} → index.html)`
            : "Preview ready",
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: errorText(err) };
  }
}

export async function executeForgeTool(
  appId: number,
  name: string,
  rawArgs: Record<string, unknown>,
  userId?: number | null,
): Promise<ForgeToolResult> {
  let last: ForgeToolResult = { error: "unknown" };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await executeForgeToolOnce(appId, name, rawArgs, userId);
    if (!last.error || !isTransientDatabaseError(last.error)) return last;
    await pause(150 * (attempt + 1));
  }
  return last;
}
