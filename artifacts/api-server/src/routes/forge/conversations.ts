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

/** Last-resort only: trivial "says X" pages when the model cannot deliver. */
function trySimpleAppBuild(userText: string): { path: string; content: string; summary: string } | null {
  const t = userText.toLowerCase().trim();
  if (/\b(calendar|month|days?|week|date|schedule|todo|list|form|login|signup|button|click|counter|timer|game|quiz|chart|table|api|fetch|database|auth|account|cart|shop|chat|message|upload|image|video|map|search|filter|sort|nav|menu|sidebar|dashboard)\b/.test(t)) {
    return null;
  }
  const wantsSimple =
    /^make an? app that says\b/i.test(userText.trim())
    || /\btext that says\b/.test(t)
    || /\bjust (has|show|says)\b/.test(t);
  if (!wantsSimple) return null;
  const quoted = userText.match(/["\u201c']([^"\u201d']{1,80})["\u201d']/);
  let label = (quoted?.[1] ?? "").trim();
  if (!label) {
    const m = userText.match(/\b(?:text|says?|has|show)\s+["']?([A-Za-z0-9 !?.-]{1,40}?)(?:["']|\s+(?:on|with|in)\b|$)/i);
    label = (m?.[1] ?? "").trim();
  }
  if (!label || label.length > 40) return null;
  const bg = /blue/.test(t) ? "#2563eb" : /green/.test(t) ? "#16a34a" : /red/.test(t) ? "#dc2626" : /black/.test(t) ? "#0f172a" : "#2563eb";
  const fg = "#ffffff";
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>App</title><style>html,body{width:100%;height:100%;margin:0}body{min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;background:${bg};color:${fg};font-family:system-ui,sans-serif;font-size:clamp(2rem,8vw,4rem);font-weight:600}</style></head><body><div>${escapeHtml(label)}</div></body></html>`;
  return { path: "index.html", content: html, summary: "Created index.html" };
}

/** Last-resort: current-month calendar when the model cannot deliver. */
function tryMonthCalendarBuild(userText: string): { path: string; content: string; summary: string } | null {
  const t = userText.toLowerCase().trim();
  const asksDays =
    (/\b(day|days)\b/.test(t) && /\b(month|this month|current month)\b/.test(t))
    || (/\bcalendar\b/.test(t) && /\b(month|this month)\b/.test(t))
    || /\bdays? in (this|the|current)?\s*month\b/.test(t);
  if (!asksDays || !/\b(make|build|create|show|display|write|app|page)\b/.test(t)) return null;
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>This month</title>
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;min-height:100dvh}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:1.25rem;display:flex;flex-direction:column;align-items:center}
h1{font-size:1.25rem;margin:0 0 1rem;text-align:center}
.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:.4rem;width:min(100%,22rem)}
.dow{text-align:center;font-size:.7rem;color:#94a3b8;font-weight:600;padding:.25rem 0}
.day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:.5rem;background:#1e293b;font-size:.95rem}
.day.empty{background:transparent}.day.today{background:#2563eb;color:#fff;font-weight:700}
</style></head><body>
<h1 id="title">This month</h1><div class="grid" id="grid"></div>
<script>
(function(){const now=new Date(),y=now.getFullYear(),m=now.getMonth(),today=now.getDate();
document.getElementById("title").textContent=now.toLocaleString(undefined,{month:"long",year:"numeric"});
const grid=document.getElementById("grid");
["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(d=>{const e=document.createElement("div");e.className="dow";e.textContent=d;grid.appendChild(e)});
const start=new Date(y,m,1).getDay(),n=new Date(y,m+1,0).getDate();
for(let i=0;i<start;i++){const e=document.createElement("div");e.className="day empty";grid.appendChild(e)}
for(let d=1;d<=n;d++){const e=document.createElement("div");e.className="day"+(d===today?" today":"");e.textContent=String(d);grid.appendChild(e)}
})();
</script></body></html>`;
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
  if (t.split(/\s+/).length <= 6 && !/\b(make|build|create|write|pull|import|github|repo|html|css|app)\b/i.test(t)) return true;
  return false;
}

function quickChatReply(userText: string): string {
  const t = userText.trim().toLowerCase();
  if (/thank|thx/.test(t)) return "You're welcome! Describe an app to build, or say **pull from my connected repo**.";
  if (/what can you|help|how does/.test(t)) {
    return "I build real web apps from your description. Try a counter, a todo list, a calendar, a form — or **pull from my connected repo**. Then press **Run**.";
  }
  return "Hi! Describe the app you want (todo list, counter, calendar, form, …) or **pull from my connected repo**.";
}

function deriveAppTitle(userText: string): string {
  const t = userText.trim().replace(/\s+/g, " ");
  if (!t) return "New App";
  const quoted = userText.match(/["\u201c']([^"\u201d']{1,40})["\u201d']/);
  if (quoted?.[1]?.trim()) {
    const q = quoted[1].trim();
    return q.charAt(0).toUpperCase() + q.slice(1);
  }
  let title = t.replace(/^(please\s+)?(make|build|create|write)\s+(me\s+)?(an?\s+)?(app|page|website|site)\s+(that\s+)?/i, "").trim();
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
  const result = await db.select().from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(result.filter((c) => c.source === "forge").map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })));
});

router.post("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New App" } = req.body as { title?: string };
  if (!userId) { res.status(201).json({ id: -1, title, createdAt: new Date().toISOString() }); return; }
  const existing = await db.select().from(conversations).where(eq(conversations.userId, userId));
  if (existing.filter((c) => c.source === "forge").length >= 10) {
    res.status(400).json({ error: "You've reached the 10-app limit. Delete an app to make room for a new one." });
    return;
  }
  const [created] = await db.insert(conversations).values({ title, language: "General", source: "forge", userId }).returning();
  res.status(201).json({ id: created.id, title: created.title, createdAt: created.createdAt });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({ id: conv.id, title: conv.title, createdAt: conv.createdAt,
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

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.

You are Forge. You build real, working single-page web apps that match the user's request.

Rules:
- Always use tools: write_file for index.html (complete HTML/CSS/JS), then run_preview.
- Do NOT invent a generic "hi" page. Implement what they asked for (calendar, counter, form, list, etc.).
- One self-contained index.html with inline CSS/JS is preferred.
- Mobile-friendly: viewport meta, full-width layout.
- Every tool call needs a short summary.
- GitHub pull/import → import_github_repo only.
${isPersisted ? "" : "User is not logged in — ask them to log in before building."}`;

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
          const msg = "\n\nLog in and connect GitHub in **Settings** (PAT with repo scope), then try again: pull from my connected repo.";
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else {
          const importResult = await runTool("import_github_repo", { path: "", summary: "Imported GitHub repo" });
          const importedOutput = importResult.output as { hasIndexHtml?: boolean; imported?: number; files?: string[] } | undefined;
          if (!importResult.error && importedOutput?.hasIndexHtml) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
          let msg: string;
          if (importResult.error) msg = `\n\nI couldn't pull that repository: ${importResult.error}`;
          else if (importedOutput?.hasIndexHtml) msg = `\n\nPulled **${importedOutput.imported ?? 0}** file(s) from your connected GitHub repo. Press **Run** to preview.`;
          else {
            const names = (importedOutput?.files ?? []).slice(0, 12).join(", ") || "(none listed)";
            msg = `\n\nPulled files (${names}) but there is no **index.html**. Ask me to create one.`;
          }
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
            content: `${systemPrompt}\n\nUse the JSON tool protocol. Build the real app the user asked for with write_file (full index.html) + run_preview. Never substitute a generic hi page.`,
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
            decision = await localAgentTurn(workingMessages, localTools, { maxNewTokens: 900, fast: true });
          } catch (modelErr) {
            const detail = modelErr instanceof Error ? modelErr.message : String(modelErr);
            const fallback = tryMonthCalendarBuild(content) ?? trySimpleAppBuild(content);
            if (fallback) {
              await runTool("write_file", { path: fallback.path, content: fallback.content, summary: fallback.summary });
              await runTool("run_preview", { summary: "Preview ready" });
              const msg = "\n\nThe model had trouble, so I used a built-in layout for this request. Press **Run**.";
              savedContent += msg;
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              endedNaturally = true;
            } else {
              const msg = `\n\nLocal model error: ${detail}. Try describing the UI more simply.`;
              savedContent += msg;
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
              endedNaturally = true;
            }
            break;
          }

          if (decision.kind === "final") {
            const text = decision.content.trim();
            if ((text.startsWith("{") && text.includes("summary")) || isToolProtocolLeak(text)) {
              const fallback = tryMonthCalendarBuild(content) ?? trySimpleAppBuild(content);
              if (fallback) {
                await runTool("write_file", { path: fallback.path, content: fallback.content, summary: fallback.summary });
                await runTool("run_preview", { summary: "Preview ready" });
                const msg = "\n\nSaved **index.html**. Press **Run** to open the preview.";
                savedContent += msg;
                if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
                endedNaturally = true;
              } else {
                const msg = "\n\nI couldn't finish that cleanly. Try a clearer description of the app UI.";
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
            const out = result.output as { hasIndexHtml?: boolean } | undefined;
            if (!result.error && out?.hasIndexHtml) await runTool("run_preview", { summary: "Preview ready" });
            const msg = result.error ? `\n\nImport failed: ${result.error}` : "\n\nImport finished. Press **Run** if index.html is present.";
            savedContent += msg;
            if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
            endedNaturally = true;
            break;
          }

          const toolResult = await runTool(decision.name, args);
          workingMessages.push({ role: "assistant", content: JSON.stringify({ tool: decision.name, arguments: args }) });
          workingMessages.push(buildLocalToolResultMessage(decision.name, toolResult));

          if (decision.name === "write_file" && !toolResult.error) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
        }

        if (!endedNaturally) {
          const fallback = lastToolError
            ? `\n\nStopped after a tool error: ${lastToolError}`
            : "\n\nCouldn't finish that build. Try a simpler description, or pull from my connected repo.";
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
          ? `GitHub pull failed: ${detail}. Check Settings → GitHub (PAT with repo scope).`
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
