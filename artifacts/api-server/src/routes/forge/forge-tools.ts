import { db, forgeAppFiles, forgeAppData, forgeAppTables, forgeAppTableRows } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import type { FunctionDeclaration } from "@google/genai";
import { saveBackendHandler } from "./forge-handler-storage";
import { executeGithubTool, isGithubReady } from "../github-tools";
import { buildWorkspacePackage } from "./forge-workspace-build";

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
    description: "Pull connected repo into Forge. Prefers local axis-preview dist (seconds).",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional subdirectory" },
        ...summaryProp,
      },
      required: ["summary"],
    },
  },
  {
    name: "db_get",
    description: "Read a value from app key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_set",
    description: "Write a value to app key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
        ...summaryProp,
      },
      required: ["key", "value", "summary"],
    },
  },
  {
    name: "db_delete",
    description: "Delete a key from app storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_list",
    description: "List keys in app storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { prefix: { type: "string" }, ...summaryProp },
      required: ["summary"],
    },
  },
  {
    name: "create_table",
    description: "Define a structured data table.",
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
    description: "List app tables.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
  {
    name: "table_insert",
    description: "Insert a row.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "string" },
        ...summaryProp,
      },
      required: ["table", "data", "summary"],
    },
  },
  {
    name: "table_select",
    description: "Read rows.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string" },
        ...summaryProp,
      },
      required: ["table", "summary"],
    },
  },
  {
    name: "table_update",
    description: "Update rows.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string" },
        data: { type: "string" },
        ...summaryProp,
      },
      required: ["table", "filter", "data", "summary"],
    },
  },
  {
    name: "table_delete",
    description: "Delete rows.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string" },
        ...summaryProp,
      },
      required: ["table", "filter", "summary"],
    },
  },
  {
    name: "write_backend_handler",
    description: "Define backend route logic.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        route: { type: "string" },
        code: { type: "string" },
        ...summaryProp,
      },
      required: ["method", "route", "code", "summary"],
    },
  },
  {
    name: "add_accounts",
    description: "Enable sign-up/login.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
  {
    name: "build_workspace_app",
    description: "Load package dist into Forge app.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        package: { type: "string" },
        ...summaryProp,
      },
      required: ["summary"],
    },
  },
  {
    name: "run_preview",
    description: "Confirm preview ready.",
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
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAlreadyCompletedError(error: string): boolean {
  return /\b(already exists|duplicate key|duplicate table)\b/i.test(error);
}

function isTransientDatabaseError(error: string): boolean {
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated|deadlock)\b/i.test(error);
}

async function pause(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const PREVIEW_EXTS = new Set(["html", "htm", "css", "js", "mjs", "cjs", "json", "md", "txt", "svg", "xml", "map"]);

function isPreviewFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".")) return false;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return PREVIEW_EXTS.has(ext);
}

function isPlaceholderHtml(content: string): boolean {
  const c = content.toLowerCase();
  if (/>hi<|>hello<|>welcome to my web app</.test(c) && content.length < 2500) return true;
  return false;
}

function isSpaShellHtml(content: string): boolean {
  const c = content.toLowerCase();
  if (!c.includes('id="root"') && !c.includes("id='root'")) return false;
  if (/src\s*=\s*["'][^"']*\.(tsx|jsx|ts)["']/.test(c)) return true;
  if (/src\s*=\s*["'][^"']*\/src\/main\.(tsx|jsx|ts|js)["']/.test(c)) return true;
  return false;
}

function spaLandingHtml(fromPath: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Needs dist</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:1.5rem}code{background:#1e293b;padding:.2rem .4rem;border-radius:.3rem}</style></head><body>
<h1>Needs production dist</h1><p>Promoted <code>${fromPath}</code>.</p>
<p>Shell: <code>cd artifacts/axis-preview && pnpm run build</code> then pull.</p></body></html>`;
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
  const candidates = all
    .filter((f) => f.path !== "index.html" && f.path.endsWith(".html") && f.content?.trim() && !isPlaceholderHtml(f.content))
    .sort((a, b) => a.path.length - b.path.length);
  const best = candidates[0];
  const rootHasContent = !!root?.content?.trim() && !isPlaceholderHtml(root.content);
  const rootOk = rootHasContent && !isSpaShellHtml(root.content);
  if (rootOk && !force) return { ok: true };
  if (!best?.content?.trim()) {
    if (rootHasContent) return { ok: true };
    return { ok: false, files: all.map((f) => f.path).slice(0, 30) };
  }
  let contentToWrite = isSpaShellHtml(best.content) ? spaLandingHtml(best.path) : best.content;
  if (root) {
    await db.update(forgeAppFiles).set({ content: contentToWrite, updatedAt: new Date() }).where(eq(forgeAppFiles.id, root.id));
  } else {
    await db.insert(forgeAppFiles).values({ appId, path: "index.html", content: contentToWrite });
  }
  return { ok: true, from: best.path };
}

async function importGithubIntoForge(
  appId: number,
  userId: number | null,
  _rootPath: string,
): Promise<ForgeToolResult> {
  if (!userId) return { error: "Log in and connect GitHub in Settings first." };
  if (!(await isGithubReady(userId))) {
    return { error: "No GitHub repository connected. Connect GitHub in Settings." };
  }

  // FAST PATH — local dist only (this is the multi-minute fix)
  const local = await buildWorkspacePackage(appId, "axis-preview");
  if (local.ok) {
    return {
      output: {
        imported: 0,
        files: local.paths,
        hasIndexHtml: true,
        promotedFrom: local.package,
        builtFromMonorepo: { package: local.package, files: local.files, buildMs: local.buildMs },
        buildError: null,
        hint: `Loaded local ${local.package} dist (${local.files} files, ${local.buildMs}ms). Press Run.`,
      },
    };
  }

  return {
    error:
      local.error ||
      "No local axis-preview dist. In Replit shell run:\n  cd artifacts/axis-preview && pnpm run build\nThen Stop → Run and pull again (should be a few seconds).",
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
        if (/^index\.hmtl$/i.test(path)) path = "index.html";
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
        return { output: `Wrote ${path} (${content.length} bytes)` };
      }
      case "delete_file": {
        const path = String(rawArgs.path ?? "").trim().replace(/^\/+/, "");
        await db.delete(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        return { output: `Deleted ${path}` };
      }
      case "import_github_repo":
        return importGithubIntoForge(appId, userId ?? null, String(rawArgs.path ?? ""));
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
        return { output: rows.map((r) => r.key).filter((k) => !prefix || k.startsWith(prefix)) };
      }
      case "create_table": {
        const tableName = String(rawArgs.name ?? "").trim();
        const columns = safeParseJson(rawArgs.columns);
        if (!tableName) return { error: "name is required" };
        const [existing] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (existing) return { output: `Table ${tableName} already exists` };
        try {
          await db.insert(forgeAppTables).values({ appId, name: tableName, columns });
        } catch (err) {
          if (isAlreadyCompletedError(errorText(err))) return { output: `Table ${tableName} already exists` };
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
        if (!t) return { error: `Table ${tableName} does not exist` };
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
            ? await db
                .select()
                .from(forgeAppTableRows)
                .where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`))
            : await db.select().from(forgeAppTableRows).where(eq(forgeAppTableRows.tableId, t.id));
        return { output: rows.map((r) => ({ id: r.id, ...(r.data as Record<string, unknown>) })) };
      }
      case "table_update": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        const patch = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const rows = await db
          .select()
          .from(forgeAppTableRows)
          .where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        for (const row of rows) {
          await db
            .update(forgeAppTableRows)
            .set({ data: { ...(row.data as Record<string, unknown>), ...patch }, updatedAt: new Date() })
            .where(eq(forgeAppTableRows.id, row.id));
        }
        return { output: `Updated ${rows.length} row(s)` };
      }
      case "table_delete": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        const rows = await db
          .select()
          .from(forgeAppTableRows)
          .where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        for (const row of rows) await db.delete(forgeAppTableRows).where(eq(forgeAppTableRows.id, row.id));
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
      case "add_accounts":
        return { output: "Accounts enabled" };
      case "build_workspace_app": {
        const pkg = typeof rawArgs.package === "string" ? rawArgs.package : undefined;
        let result = await buildWorkspacePackage(appId, pkg);
        if (!result.ok) result = await buildWorkspacePackage(appId, pkg, { forceCompile: true });
        if (!result.ok) return { error: result.error };
        return {
          output: {
            package: result.package,
            files: result.files,
            buildMs: result.buildMs,
            reusedDist: result.reusedDist,
            hint: `Loaded ${result.package} (${result.buildMs}ms). Press Run.`,
          },
        };
      }
      case "run_preview": {
        const ensured = await ensureRootIndexHtml(appId, { force: true });
        if (!ensured.ok) return { error: `No index.html — ${ensured.files.join(", ") || "none"}` };
        return { output: "Preview ready" };
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
