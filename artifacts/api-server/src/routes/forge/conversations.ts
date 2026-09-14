import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import {
  localAgentTurn,
  buildLocalToolResultMessage,
  toLocalToolDefinitions,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { forgeToolDeclarations, executeForgeTool, truncateSummary } from "./forge-tools";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";

const router: IRouter = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;");
}

/** Only for trivial "says X" / "text X" pages — not real app requests. */
function trySimpleAppBuild(userText: string): { path: string; content: string; summary: string } | null {
  const t = userText.toLowerCase().trim();

  if (/\b(calendar|month|days?|week|date|schedule|todo|list|form|login|signup|button|click|counter|timer|game|quiz|chart|table|api|fetch|database|auth|account|cart|shop|chat|message|upload|image|video|map|search|filter|sort|nav|menu|sidebar|dashboard)\b/.test(t)) {
    return null;
  }
  if (/\b(and|with|that has|that can|which|multiple|several)\b/.test(t) && t.split(/\s+/).length > 12) {
    return null;
  }

  const wantsSimple =
    (/\b(make|build|create|write)\b/.test(t) && /\b(app|page|website|site|html)\b/.test(t) && /\b(says?|show|text|just)\b/.test(t))
    || /\b(just (has|show|says)|show (the )?text|text that says)\b/.test(t)
    || (/^make an? app that says\b/i.test(userText.trim()));

  if (!wantsSimple) return null;

  const quoted = userText.match(/["\u201c']([^"\u201d']{1,80})["\u201d']/);
  let label = (quoted?.[1] ?? "").trim();
  if (!label) {
    const m = userText.match(/\b(?:text|says?|has|show)\s+["']?([A-Za-z0-9 !?.-]{1,40}?)(?:["']|\s+(?:on|with|in)\b|$)/i);
    label = (m?.[1] ?? "").trim();
  }
  if (!label || label.length > 40) return null;
  if (/\b(days?|month|calendar|week)\b/i.test(label)) return null;

  const bg =
    /blue/.test(t) ? "#2563eb"
    : /green/.test(t) ? "#16a34a"
    : /red/.test(t) ? "#dc2626"
    : /black/.test(t) ? "#0f172a"
    : /white/.test(t) ? "#f8fafc"
    : "#2563eb";
  const fg = /white/.test(t) && !/blue|green|red|black/.test(t) ? "#0f172a" : "#ffffff";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <title>App</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
    body {
      min-height: 100%; min-height: 100dvh; width: 100%;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: ${bg}; color: ${fg};
      font-family: system-ui, -apple-system, sans-serif;
      font-size: clamp(2rem, 8vw, 4rem); font-weight: 600; overflow: hidden;
    }
    .label { width: 100%; padding: 1rem; text-align: center; }
  </style>
</head>
<body><div class="label">${escapeHtml(label)}</div></body>
</html>
`;
  return { path: "index.html", content: html, summary: "Created index.html" };
}

/** Deterministic current-month calendar page (no LLM). */
function tryMonthCalendarBuild(userText: string): { path: string; content: string; summary: string } | null {
  const t = userText.toLowerCase().trim();
  const asksDays =
    (/\b(day|days)\b/.test(t) && /\b(month|this month|current month)\b/.test(t))
    || (/\bcalendar\b/.test(t) && /\b(month|this month)\b/.test(t))
    || /\b(show|display|list)\b.+\b(days?).+\b(month)\b/.test(t)
    || /\bdays? in (this|the|current)?\s*month\b/.test(t);
  if (!asksDays) return null;
  if (!/\b(make|build|create|show|display|write|app|page)\b/.test(t)) return null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <title>This month</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; min-height: 100%; min-height: 100dvh; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #f8fafc; padding: 1.25rem;
      display: flex; flex-direction: column; align-items: center;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; text-align: center; }
    .grid {
      display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 0.4rem; width: min(100%, 22rem);
    }
    .dow { text-align: center; font-size: 0.7rem; color: #94a3b8; font-weight: 600; padding: 0.25rem 0; }
    .day {
      aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
      border-radius: 0.5rem; background: #1e293b; font-size: 0.95rem; font-weight: 500;
    }
    .day.empty { background: transparent; }
    .day.today { background: #2563eb; color: #fff; font-weight: 700; }
  </style>
</head>
<body>
  <h1 id="title">This month</h1>
  <div class="grid" id="grid"></div>
  <script>
    (function () {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const today = now.getDate();
      const title = document.getElementById("title");
      const grid = document.getElementById("grid");
      title.textContent = now.toLocaleString(undefined, { month: "long", year: "numeric" });
      for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
        const el = document.createElement("div");
        el.className = "dow";
        el.textContent = d;
        grid.appendChild(el);
      }
      const startDow = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let i = 0; i < startDow; i++) {
        const el = document.createElement("div");
        el.className = "day empty";
        grid.appendChild(el);
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const el = document.createElement("div");
        el.className = "day" + (d === today ? " today" : "");
        el.textContent = String(d);
        grid.appendChild(el);
      }
    })();
  </script>
</body>
</html>
`;
  return { path: "index.html", content: html, summary: "Created month calendar" };
}

function wantsGithubImport(userText: string): boolean {
  const t = userText.toLowerCase().trim();
  if (/\b(import_github_repo|github import)\b/.test(t)) return true;
  if (/\b(my (connected )?repo|connected repo|connected repository)\b/.test(t)) return true;
  if (/\b(pull|clone|import|load|fetch)\b/.test(t) && /\b(repo|repository|github)\b/.test(t)) return true;
  if (/\bpull from\b/.test(t) && /\b(repo|github|connected)\b/.test(t)) return true;
  return false;
}

function isQuickChat(userText: string): boolean {
  const t = userText.trim();
  if (!t || t.length > 120) return false;
  if (/^(hi|hello|hey|yo|sup|hiya|howdy)[!.?\s]*$/i.test(t)) return true;
  if (/^(hi|hello|hey)\s+(there|forge|axis)[!.?\s]*$/i.test(t)) return true;
  if (/^(thanks|thank you|thx|ok|okay|cool|great|nice)[!.?\s]*$/i.test(t)) return true;
  if (/^(what can you (do|build)|help|how does this work)[?.!\s]*$/i.test(t)) return true;
  if (t.split(/\s+/).length <= 6 && !/\b(make|build|create|write|pull|import|github|repo|html|css|app)\b/i.test(t)) {
    return true;
  }
  return false;
}

function quickChatReply(userText: string): string {
  const t = userText.trim().toLowerCase();
  if (/thank|thx/.test(t)) return "You're welcome! Describe an app to build, or say **pull from my connected repo**.";
  if (/what can you|help|how does/.test(t)) {
    return "I build small web apps. Try:\n- **make an app that says hi**\n- **show the days in this month**\n- **pull from my connected repo**\nThen press **Run** to preview.";
  }
  return "Hi! Tell me what to build (e.g. **make an app that says hi** or **show the days in this month**) or **pull from my connected repo**.";
}

function deriveAppTitle(userText: string): string {
  const t = userText.trim().replace(/\s+/g, " ");
  if (!t) return "New App";
  const quoted = userText.match(/["\u201c']([^"\u201d']{1,40})["\u201d']/);
  if (quoted?.[1]?.trim()) {
    const q = quoted[1].trim();
    return q.charAt(0).toUpperCase() + q.slice(1);
  }
  const m = userText.match(/\b(?:says?|text|show|titled?|called|named)\s+["']?([A-Za-z0-9 !?.-]{1,40})/i);
  if (m?.[1]?.trim()) {
    const q = m[1].trim().replace(/[.,!?]+$/, "");
    if (q) return q.charAt(0).toUpperCase() + q.slice(1);
  }
  let title = t
    .replace(/^(please\s+)?(make|build|create|write)\s+(me\s+)?(an?\s+)?(app|page|website|site)\s+(that\s+)?/i, "")
    .trim();
  if (!title) title = t;
  if (title.length > 36) title = title.slice(0, 33) + "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

async function autoTitleIfDefault(appId: number, userText: string): Promise<void> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, appId));
  if (!conv || conv.source !== "forge") return;
  if (conv.title !== "New App" && conv.title !== "New Chat") return;
  const title = deriveAppTitle(userText);
  if (!title || title === "New App") return;
  await db.update(conversations).set({ title }).where(eq(conversations.id, appId));
}

function isToolProtocolLeak(text: string): boolean {
  return /["']?(write_file|delete_file|import_github_repo|run_preview|db_get|db_set|db_delete|db_list|create_table|table_list|table_insert|table_select|table_update|table_delete|write_backend_handler|add_accounts)["']?\s*:/i.test(text)
    || (/["']?file["']?\s*:/.test(text) && /["']?preview["']?\s*:/.test(text) && /["']?summary["']?\s*:/.test(text))
    || (/["']?(action|tool|arguments)["']?\s*:/.test(text) && /["']?(name|tool)["']?\s*:/.test(text));
}

router.get("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "forge").map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
    }))
  );
});

router.post("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New App" } = req.body as { title?: string };
  if (!userId) {
    res.status(201).json({ id: -1, title, createdAt: new Date().toISOString() });
    return;
  }
  const existing = await db.select().from(conversations).where(eq(conversations.userId, userId));
  const forgeCount = existing.filter((c) => c.source === "forge").length;
  if (forgeCount >= 10) {
    res.status(400).json({ error: "You've reached the 10-app limit. Delete an app to make room for a new one." });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title, language: "General", source: "forge", userId })
    .returning();
  res.status(201).json({ id: created.id, title: created.title, createdAt: created.createdAt });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({
    id: conv.id, title: conv.title, createdAt: conv.createdAt,
    messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })),
  });
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, createdAt: updated.createdAt });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })));
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, guestHistory: rawGuestHistory } = req.body as { content: string; guestHistory?: Array<{role: string; content: string}> };
  const guestHistory: Array<{role: string; content: string}> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;
  const isPersisted = !!userId && id > 0;

  if (isPersisted) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  }

  const history: Array<{role: string; content: string}> = isPersisted
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (isPersisted) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
    await autoTitleIfDefault(id, content);
  }

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.\n\nYou are Forge. You build small web apps by calling tools.\nTools: write_file, delete_file, import_github_repo, run_preview, and data helpers.\nWhen the user asks to pull/import a GitHub repo, call import_github_repo.\nWhen building a simple page, write_file index.html then run_preview.\nEvery tool needs a short summary.\n${isPersisted ? "" : "User is not logged in — ask them to log in before building."}`;

  if (getAiProvider() === "local") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ status: "working" })}\n\n`);

    let savedContent = "";
    let lastToolError: string | null = null;
    let endedNaturally = false;

    const runTool = async (name: string, args: Record<string, unknown>) => {
      const toolId = `${Date.now()}-${name}`;
      const summary =
        name === "write_file" && String(args.path ?? "").trim()
          ? `Writing ${String(args.path).replace(/^\/+/, "")}`
          : name === "import_github_repo"
            ? "Pulling connected repo"
            : truncateSummary(args.summary, name);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name, summary } })}\n\n`);
      }
      const result = isPersisted
        ? await executeForgeTool(id, name, args, userId)
        : { error: "Log in first so the app can be saved." };
      if (result.error) {
        lastToolError = result.error;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary, error: result.error } })}\n\n`);
        }
        savedContent += `\n\n✗ ${summary} — ${result.error}`;
      } else {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary } })}\n\n`);
        }
        savedContent += `\n\n✓ ${summary}`;
      }
      return result;
    };

    try {
      if (isQuickChat(content)) {
        const msg = quickChatReply(content);
        savedContent += msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
        endedNaturally = true;
      } else if (wantsGithubImport(content)) {
        if (!isPersisted) {
          const msg =
            "\n\nLog in and connect GitHub in **Settings** (PAT with repo scope), then try again: pull from my connected repo.";
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else {
          const importResult = await runTool("import_github_repo", {
            path: "",
            summary: "Imported GitHub repo",
          });
          const importedOutput = importResult.output as
            | { hasIndexHtml?: boolean; imported?: number; files?: string[] }
            | undefined;
          if (!importResult.error && importedOutput?.hasIndexHtml) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
          let msg: string;
          if (importResult.error) {
            msg = `\n\nI couldn't pull that repository: ${importResult.error}`;
          } else if (importedOutput?.hasIndexHtml) {
            const n = importedOutput.imported ?? 0;
            msg = `\n\nPulled **${n}** file(s) from your connected GitHub repo into this app. Press **Run** to preview.`;
          } else {
            const names = (importedOutput?.files ?? []).slice(0, 12).join(", ") || "(none listed)";
            msg =
              `\n\nPulled files (${names}) but there is no **index.html** entry point. Ask me to create one, or import a folder that has index.html.`;
          }
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        }
      } else if (tryMonthCalendarBuild(content) && isPersisted) {
        const cal = tryMonthCalendarBuild(content)!;
        const writeResult = await runTool("write_file", {
          path: cal.path,
          content: cal.content,
          summary: cal.summary,
        });
        if (!writeResult.error) {
          await runTool("run_preview", { summary: "Preview ready" });
          const msg =
            "\n\nBuilt a calendar of **this month's days**. Press **Run** to open it.";
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else {
          const msg = `\n\nCouldn't save the file: ${writeResult.error}`;
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        }
      } else if (trySimpleAppBuild(content) && isPersisted) {
        const simple = trySimpleAppBuild(content)!;
        const writeResult = await runTool("write_file", {
          path: simple.path,
          content: simple.content,
          summary: simple.summary,
        });
        if (!writeResult.error) {
          await runTool("run_preview", { summary: "Preview ready" });
          const msg =
            "\n\nSaved **index.html** and verified it in storage. Press **Run** to open the preview.";
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else {
          const msg = `\n\nCouldn't save the file: ${writeResult.error}`;
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        }
      } else if (!isPersisted) {
        const msg = "\n\nLog in first so Forge can save your app files.";
        savedContent += msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
        endedNaturally = true;
      } else {
        const workingMessages: LocalChatMessage[] = [
          {
            role: "system",
            content: `${systemPrompt}\n\nUse the JSON tool protocol. Prefer write_file + run_preview for UI apps.`,
          },
          ...history.slice(-5).map((m): LocalChatMessage => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.slice(0, 1800),
          })),
          { role: "user", content: content.slice(0, 3000) },
        ];
        const localTools = toLocalToolDefinitions(forgeToolDeclarations);

        for (let turn = 0; turn < 8; turn++) {
          let decision;
          try {
            decision = await localAgentTurn(workingMessages, localTools, { maxNewTokens: 600, fast: true });
          } catch (modelErr) {
            const detail = modelErr instanceof Error ? modelErr.message : String(modelErr);
            const cal = tryMonthCalendarBuild(content);
            const fallback = cal ?? trySimpleAppBuild(content);
            if (fallback) {
              await runTool("write_file", {
                path: fallback.path,
                content: fallback.content,
                summary: fallback.summary,
              });
              await runTool("run_preview", { summary: "Preview ready" });
              const msg =
                "\n\nThe local model had trouble, so I built a page instead. Press **Run**.";
              savedContent += msg;
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              endedNaturally = true;
            } else {
              const msg = `\n\nLocal model error: ${detail}. Try: make an app that says hi — or show the days in this month.`;
              savedContent += msg;
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              endedNaturally = true;
            }
            break;
          }

          if (decision.kind === "final") {
            const text = decision.content.trim();
            if ((text.startsWith("{") && text.includes("summary")) || isToolProtocolLeak(text)) {
              const cal = tryMonthCalendarBuild(content);
              const fallback = cal ?? trySimpleAppBuild(content);
              if (fallback) {
                await runTool("write_file", {
                  path: fallback.path,
                  content: fallback.content,
                  summary: fallback.summary,
                });
                await runTool("run_preview", { summary: "Preview ready" });
                const msg =
                  "\n\nSaved **index.html**. Press **Run** to open the preview.";
                savedContent += msg;
                if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
                endedNaturally = true;
              } else {
                const msg =
                  "\n\nI couldn't finish that cleanly. Try: show the days in this month.";
                savedContent += msg;
                if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
                endedNaturally = true;
              }
            } else {
              endedNaturally = true;
              savedContent += text;
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
            break;
          }

          const args = { ...decision.arguments };
          if (decision.name === "write_file" && !String(args.content ?? "").trim()) {
            const filled = tryMonthCalendarBuild(content) ?? trySimpleAppBuild(content);
            if (filled) {
              args.path = filled.path;
              args.content = filled.content;
              args.summary = filled.summary;
            }
          }

          if (decision.name === "import_github_repo") {
            const result = await runTool(decision.name, args);
            const out = result.output as { hasIndexHtml?: boolean; imported?: number } | undefined;
            if (!result.error && out?.hasIndexHtml) {
              await runTool("run_preview", { summary: "Preview ready" });
            }
            const msg = result.error
              ? `\n\nImport failed: ${result.error}`
              : `\n\nImport finished. Press **Run** if index.html is present.`;
            savedContent += msg;
            if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
            endedNaturally = true;
            break;
          }

          const toolResult = await runTool(decision.name, args);
          workingMessages.push({
            role: "assistant",
            content: JSON.stringify({ tool: decision.name, arguments: args }),
          });
          workingMessages.push(buildLocalToolResultMessage(decision.name, toolResult));

          if (decision.name === "write_file" && !toolResult.error) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
        }

        if (!endedNaturally) {
          const fallback = lastToolError
            ? `\n\nStopped after a tool error: ${lastToolError}`
            : "\n\nCouldn't finish that build. Try: show the days in this month — or pull from my connected repo";
          savedContent += fallback;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
        }
      }

      if (isPersisted && savedContent) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[forge] build error", err);
      const friendlyMessage =
        wantsGithubImport(content)
          ? `GitHub pull failed: ${detail}. Check Settings → GitHub (PAT with repo scope) and that a repo is selected.`
          : friendlyGeminiErrorMessage(err, `Build failed: ${detail}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
        res.end();
      }
    }
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ error: "Cloud AI is not configured. Set AXIS_AI_PROVIDER=local." })}\n\n`);
    res.end();
  }
});

export default router;
