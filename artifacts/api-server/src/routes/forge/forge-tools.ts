import { db, forgeAppFiles, forgeAppData, forgeAppTables, forgeAppTableRows } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import type { FunctionDeclaration } from "@google/genai";
import { saveBackendHandler } from "./forge-handler-storage";

// Every tool requires a `summary` argument: a concise, past-tense description of
// what this call does, 8 words max. The model provides it; we enforce the cap
// server-side as a safety net (see truncateSummary below).

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
    description: "Define a new structured data table for the app.",
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
    description: "Add sign-up/login accounts to the app. NOTE: not yet available — calling this just informs the user it's coming soon.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
  {
    name: "run_preview",
    description: "Signal that the app is ready to preview. NOTE: not yet available — calling this just informs the user it's coming soon.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
];

export function truncateSummary(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  const words = text.split(/\s+/);
  return words.length > 8 ? words.slice(0, 8).join(" ") + "…" : text;
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Executes a Forge tool call. This is deliberately DB-only — no generated code
 * ever runs here. Real sandboxed execution of app *logic* is a separate, later
 * phase; this is just safe, server-controlled CRUD against tables scoped to appId.
 */
export async function executeForgeTool(
  appId: number,
  name: string,
  rawArgs: Record<string, unknown>
): Promise<{ output?: unknown; error?: string }> {
  try {
    switch (name) {
      case "write_file": {
        const path = String(rawArgs.path ?? "");
        const content = String(rawArgs.content ?? "");
        if (!path) return { error: "path is required" };
        const [existing] = await db.select().from(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        if (existing) {
          await db.update(forgeAppFiles).set({ content, updatedAt: new Date() }).where(eq(forgeAppFiles.id, existing.id));
        } else {
          await db.insert(forgeAppFiles).values({ appId, path, content });
        }
        return { output: `Wrote ${path}` };
      }
      case "delete_file": {
        const path = String(rawArgs.path ?? "");
        await db.delete(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        return { output: `Deleted ${path}` };
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
        const tableName = String(rawArgs.name ?? "");
        const columns = safeParseJson(rawArgs.columns);
        if (!tableName) return { error: "name is required" };
        const [existing] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (existing) return { output: `Table ${tableName} already exists` };
        await db.insert(forgeAppTables).values({ appId, name: tableName, columns });
        return { output: `Created table ${tableName}` };
      }
      case "table_insert": {
        const tableName = String(rawArgs.table ?? "");
        const rowData = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist — create it first` };
        const [inserted] = await db.insert(forgeAppTableRows).values({ tableId: t.id, data: rowData }).returning();
        return { output: { id: inserted.id, ...rowData } };
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
        await db.delete(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        return { output: "ok" };
      }
      case "write_backend_handler": {
        const method = String(rawArgs.method ?? "").toUpperCase();
        const route = String(rawArgs.route ?? "");
        const code = String(rawArgs.code ?? "");
        if (!method || !route || !code) return { error: "method, route, and code are all required" };
        await saveBackendHandler(appId, method, route, code);
        return { output: `Defined ${method} ${route}` };
      }
      case "add_accounts":
        return { output: "Account support isn't available yet — it's coming in a later update." };
      case "run_preview":
        return { output: "Running/previewing apps isn't available yet — it's coming in a later update." };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
