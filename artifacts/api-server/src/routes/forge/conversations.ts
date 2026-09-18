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

/** Deterministic single-page apps — no model required. */
function tryDeterministicApp(userText: string): { path: string; content: string; summary: string } | null {
  const t = userText.toLowerCase().trim();
  if (!t || t.length > 400) return null;
  if (/\b(pull|import|github|repo|preview ready|index\.html)\b/.test(t) && !/\b(make|build|create)\b/.test(t)) {
    return null;
  }

  const asksDays =
    (/\b(day|days)\b/.test(t) && /\b(month|this month|current month)\b/.test(t))
    || (/\bcalendar\b/.test(t) && /\b(month|this month)\b/.test(t))
    || /\bdays? in (this|the|current)?\s*month\b/.test(t);
  if (asksDays && /\b(make|build|create|show|display|write|app|page)\b/.test(t)) {
    return {
      path: "index.html",
      summary: "Created month calendar",
      content: `<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>This month</title>\n<style>\n*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;min-height:100dvh}\nbody{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:1.25rem;display:flex;flex-direction:column;align-items:center}\nh1{font-size:1.25rem;margin:0 0 1rem;text-align:center}\n.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:.4rem;width:min(100%,22rem)}\n.dow{text-align:center;font-size:.7rem;color:#94a3b8;font-weight:600;padding:.25rem 0}\n.day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:.5rem;background:#1e293b;font-size:.95rem}\n.day.empty{background:transparent}.day.today{background:#2563eb;color:#fff;font-weight:700}\n</style></head><body>\n<h1 id="title">This month</h1><div class="grid" id="grid"></div>\n<script>\n(function(){const now=new Date(),y=now.getFullYear(),m=now.getMonth(),today=now.getDate();\ndocument.getElementById("title").textContent=now.toLocaleString(undefined,{month:"long",year:"numeric"});\nconst grid=document.getElementById("grid");\n["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(d=>{const e=document.createElement("div");e.className="dow";e.textContent=d;grid.appendChild(e)});\nconst start=new Date(y,m,1).getDay(),n=new Date(y,m+1,0).getDate();\nfor(let i=0;i<start;i++){const e=document.createElement("div");e.className="day empty";grid.appendChild(e)}\nfor(let d=1;d<=n;d++){const e=document.createElement("div");e.className="day"+(d===today?" today":"");e.textContent=String(d);grid.appendChild(e)}\n})();\n</script></body></html>`,
    };
  }

  if (/\bcounter\b/.test(t) && /\b(make|build|create|app|page)\b/.test(t)) {
    return {
      path: "index.html",
      summary: "Created counter app",
      content: `<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>Counter</title>\n<style>\n*{box-sizing:border-box}html,body{margin:0;height:100%;width:100%}\nbody{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem;background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif}\n#n{font-size:clamp(3rem,15vw,6rem);font-weight:700}\n.row{display:flex;gap:.75rem}\nbutton{font-size:1.25rem;padding:.6rem 1.25rem;border:0;border-radius:.75rem;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}\nbutton.secondary{background:#334155}\n</style></head><body>\n<div id="n">0</div>\n<div class="row">\n<button type="button" id="dec">−</button>\n<button type="button" id="reset" class="secondary">Reset</button>\n<button type="button" id="inc">+</button>\n</div>\n<script>\nlet n=0;const el=document.getElementById("n");\nconst render=()=>{el.textContent=String(n)};\ndocument.getElementById("inc").onclick=()=>{n++;render()};\ndocument.getElementById("dec").onclick=()=>{n--;render()};\ndocument.getElementById("reset").onclick=()=>{n=0;render()};\n</script></body></html>`,
    };
  }

  if (/\b(todo|to-do|task list|checklist)\b/.test(t) && /\b(make|build|create|app|page)\b/.test(t)) {
    return {
      path: "index.html",
      summary: "Created todo list",
      content: `<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>Todos</title>\n<style>\n*{box-sizing:border-box}html,body{margin:0;min-height:100dvh}\nbody{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:1.25rem;max-width:28rem;margin:0 auto}\nh1{font-size:1.25rem;margin:0 0 1rem}\nform{display:flex;gap:.5rem;margin-bottom:1rem}\ninput{flex:1;padding:.65rem .75rem;border-radius:.5rem;border:1px solid #334155;background:#1e293b;color:#fff}\nbutton{padding:.65rem 1rem;border:0;border-radius:.5rem;background:#2563eb;color:#fff;font-weight:600}\nul{list-style:none;padding:0;margin:0}\nli{display:flex;align-items:center;gap:.5rem;padding:.6rem .5rem;border-bottom:1px solid #1e293b}\nli.done span{text-decoration:line-through;opacity:.55}\nli button{background:#334155;font-size:.75rem;padding:.35rem .6rem}\n</style></head><body>\n<h1>Todos</h1>\n<form id="f"><input id="i" placeholder="Add a task…" autocomplete="off"/><button type="submit">Add</button></form>\n<ul id="list"></ul>\n<script>\nconst list=document.getElementById("list");const items=[];\nconst render=()=>{list.innerHTML="";items.forEach((it,idx)=>{\n  const li=document.createElement("li");if(it.done)li.className="done";\n  const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!it.done;\n  cb.onchange=()=>{it.done=!it.done;render()};\n  const sp=document.createElement("span");sp.textContent=it.text;sp.style.flex="1";\n  const del=document.createElement("button");del.type="button";del.textContent="Delete";\n  del.onclick=()=>{items.splice(idx,1);render()};\n  li.append(cb,sp,del);list.appendChild(li);\n})};\ndocument.getElementById("f").onsubmit=(e)=>{e.preventDefault();\n  const v=document.getElementById("i").value.trim();if(!v)return;\n  items.push({text:v,done:false});document.getElementById("i").value="";render();\n};\n</script></body></html>`,
    };
  }

  const wantsSimple =
    /^make an? app that says\b/i.test(userText.trim())
    || /\btext that says\b/.test(t)
    || /\bjust (has|show|says)\b/.test(t);
  if (wantsSimple) {
    const quoted = userText.match(/["\u201c']([^"\u201d']{1,80})["\u201d']/);
    let label = (quoted?.[1] ?? "").trim();
    if (!label) {
      const m = userText.match(/\b(?:text|says?|has|show)\s+["']?([A-Za-z0-9 !?.-]{1,40}?)(?:["']|\s+(?:on|with|in)\b|$)/i);
      label = (m?.[1] ?? "").trim();
    }
    if (label && label.length <= 40) {
      const bg = /blue/.test(t) ? "#2563eb" : /green/.test(t) ? "#16a34a" : /red/.test(t) ? "#dc2626" : /black/.test(t) ? "#0f172a" : "#2563eb";
      const safe = label.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>App</title><style>html,body{width:100%;height:100%;margin:0}body{min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;background:${bg};color:#fff;font-family:system-ui,sans-serif;font-size:clamp(2rem,8vw,4rem);font-weight:600}</style></head><body><div>${safe}</div></body></html>`;
      return { path: "index.html", content: html, summary: "Created index.html" };
    }
  }
  return null;
}

function wantsEnsurePreview(userText: string): boolean {
  const t = userText.toLowerCase().trim();
  if (/\bindex\.html\b/.test(t)) return true;
  if (/\b(make|get|set)\b.{0,20}\bpreview\b/.test(t)) return true;
  if (/\bpreview\b.{0,20}\b(ready|work|open|run)\b/.test(t)) return true;
  if (/\b(add|write|create)\b.{0,30}\b(index|html|entry)\b/.test(t)) return true;
  if (/^add index/i.test(t) || /^write index/i.test(t)) return true;
  return false;
}

function wantsDescribeRepo(userText: string): boolean {
  const t = userText.toLowerCase().trim();
  if (/\b(describe|explain|what is|what's|whats|tell me about|summarize)\b/.test(t) && /\b(repo|repository|github)\b/.test(t)) return true;
  if (/^describe\b/.test(t) && /\b(repo|it|this)\b/.test(t)) return true;
  return false;
}

/** Only true for explicit pull/import actions — not "describe my repo". */
function wantsGithubImport(userText: string): boolean {
  const t = userText.toLowerCase().trim();
  if (wantsDescribeRepo(userText)) return false;
  if (wantsEnsurePreview(userText) && !/\b(pull|clone|import)\b/.test(t)) return false;
  if (/\b(import_github_repo|github import)\b/.test(t)) return true;
  // "pull again" / "pull" alone after a prior pull context
  if (/^(pull|clone|import)\s*(again|it|the repo|my repo|from (my )?(connected )?(repo|github))?\.?$/i.test(t)) return true;
  if (/\b(pull|clone|import|fetch)\b/.test(t) && /\b(repo|repository|github|connected)\b/.test(t)) return true;
  if (/\bpull from\b/.test(t)) return true;
  if (/\b(wire|load)\b/.test(t) && /\b(repo|github)\b/.test(t) && /\b(preview|run|into)\b/.test(t)) return true;
  return false;
}

function describeConnectedRepoReply(): string {
  return (
    "Your connected repo is **Axis** — a pnpm TypeScript monorepo.\n\n" +
    "It includes:\n" +
    "- **artifacts/api-server** — Express API (Forge chat, preview, GitHub tools)\n" +
    "- **artifacts/axis-preview** and other frontends (Vite/React)\n" +
    "- **lib/** — shared db, API client, AI integrations\n\n" +
    "Unlike a single HTML file (e.g. ButtonPresser), Axis needs a Vite build for a real preview. " +
    "Say **pull from my connected repo** to load files, then **Run**. " +
    "If the preview is blank, say **build axis-preview**."
  );
}

function isQuickChat(userText: string): boolean {
  const t = userText.trim();
  if (!t || t.length > 120) return false;
  if (/^(hi|hello|hey|yo|sup|hiya|howdy)[!.?\s]*$/i.test(t)) return true;
  if (/^(hi|hello|hey)\s+(there|forge|axis)[!.?\s]*$/i.test(t)) return true;
  if (/^(thanks|thank you|thx|ok|okay|cool|great|nice)[!.?\s]*$/i.test(t)) return true;
  if (/^(what can you (do|build)|help|how does this work)[?.!\s]*$/i.test(t)) return true;
  if (t.split(/\s+/).length <= 6 && !/\b(make|build|create|write|pull|import|github|repo|html|css|app|index|add|preview|run)\b/i.test(t)) return true;
  return false;
}

function quickChatReply(userText: string): string {
  const t = userText.trim().toLowerCase();
  if (/thank|thx/.test(t)) return "You're welcome! Describe an app to build, or say **pull from my connected repo**.";
  if (/what can you|help|how does/.test(t)) {
    return "I build real web apps from your description. Try a counter, a todo list, a calendar — or **pull from my connected repo**. Then press **Run**.";
  }
  return "Hi! Describe the app you want (todo list, counter, calendar, …) or **pull from my connected repo**.";
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
  const { content, guestHistory: rawGuestHistory } = req.body as { content: string; guestHistory?: Array<{ role: string; content: string }> };
  const guestHistory: Array<{ role: string; content: string }> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;
  const isPersisted = !!userId && id > 0;

  if (isPersisted) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  }

  const history: Array<{ role: string; content: string }> = isPersisted
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (isPersisted) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
    await autoTitleIfDefault(id, content);
  }

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.\n\nYou are Forge. You build real, working single-page web apps that match the user's request.\n\nRules:\n- Always use tools: write_file for index.html (complete HTML/CSS/JS), then run_preview.\n- Do NOT invent a generic "hi" page. Implement what they asked for.\n- One self-contained index.html with inline CSS/JS is preferred.\n- Mobile-friendly: viewport meta, full-width layout.\n- Every tool call needs a short summary.\n- GitHub pull/import → import_github_repo only when the user asks to pull/import.\n- If they ask to describe the repo, answer in text — do not pull.\n${isPersisted ? "" : "User is not logged in — ask them to log in before building."}`;

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
      } else if (wantsDescribeRepo(content)) {
        const msg = "\n\n" + describeConnectedRepoReply();
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
          const importedOutput = importResult.output as {
            hasIndexHtml?: boolean;
            imported?: number;
            files?: string[];
            promotedFrom?: string;
            builtFromMonorepo?: { package?: string; files?: number; buildMs?: number } | null;
            buildError?: string | null;
          } | undefined;
          if (!importResult.error && importedOutput?.hasIndexHtml) {
            await runTool("run_preview", { summary: "Preview ready" });
          }
          let msg: string;
          if (importResult.error) msg = `\n\nI couldn't pull that repository: ${importResult.error}`;
          else if (importedOutput?.builtFromMonorepo?.package) {
            const b = importedOutput.builtFromMonorepo;
            msg = `\n\nBuilt **${b.package}** from the local monorepo (**${b.files ?? "?"}** files, **${b.buildMs ?? "?"}ms**). Press **Run** to preview.`;
          } else if (importedOutput?.buildError) {
            msg = `\n\nPulled **${importedOutput.imported ?? 0}** file(s), but the monorepo build failed:\n\`${String(importedOutput.buildError).slice(0, 500)}\`\n\nTry: **build axis-preview**.`;
          } else if (importedOutput?.hasIndexHtml) {
            const promoted = importedOutput.promotedFrom;
            msg = promoted
              ? `\n\nPulled **${importedOutput.imported ?? 0}** file(s). Promoted **${promoted}** → **index.html**. Press **Run** to preview.`
              : `\n\nPulled **${importedOutput.imported ?? 0}** file(s) from your connected GitHub repo. Press **Run** to preview.`;
          } else {
            const names = (importedOutput?.files ?? []).slice(0, 12).join(", ") || "(none listed)";
            msg = `\n\nPulled files (${names}) but there is no **index.html**. Try **build axis-preview** or **make a counter app**.`;
          }
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        }
      } else {
        const det = tryDeterministicApp(content);
        if (det && isPersisted) {
          await runTool("write_file", { path: det.path, content: det.content, summary: det.summary });
          await runTool("run_preview", { summary: "Preview ready" });
          const msg = `\n\n${det.summary}. Press **Run** to preview.`;
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else if (wantsEnsurePreview(content) && isPersisted) {
          const result = await runTool("run_preview", { summary: "Preview ready" });
          const msg = result.error
            ? `\n\n${result.error}\n\nSay **pull from my connected repo** after rebuild, or try **make a counter app**.`
            : "\n\nPreview is ready. Press **Run**.";
          savedContent += msg;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
          endedNaturally = true;
        } else {
          // Fall through to local model
          const tools = toLocalToolDefinitions(forgeToolDeclarations as unknown as Array<{ name: string; description?: string; parametersJsonSchema?: unknown }>);
          const msgs: LocalChatMessage[] = [
            { role: "system", content: systemPrompt },
            ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            { role: "user", content },
          ];
          const turn = await localAgentTurn({ messages: msgs, tools });
          if (turn.toolCalls?.length) {
            for (const tc of turn.toolCalls) {
              const result = await runTool(tc.name, (tc.arguments ?? {}) as Record<string, unknown>);
              if (result.error) lastToolError = result.error;
            }
          }
          if (turn.content && !isToolProtocolLeak(turn.content)) {
            savedContent += turn.content;
            if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: turn.content })}\n\n`);
          }
          endedNaturally = true;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[forge] local path error", err);
      const friendlyMessage =
        wantsGithubImport(content)
          ? `GitHub pull failed: ${detail}. Check Settings → GitHub (PAT with repo scope).`
          : `Something went wrong: ${detail}`;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
      }
    }

    if (isPersisted && savedContent.trim()) {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent.trim() });
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-local (Gemini) path — still honor describe vs pull
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ status: "working" })}\n\n`);

  let savedContent = "";
  try {
    if (wantsDescribeRepo(content)) {
      const msg = "\n\n" + describeConnectedRepoReply();
      savedContent += msg;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
    } else if (wantsGithubImport(content) && isPersisted) {
      const importResult = await executeForgeTool(id, "import_github_repo", { path: "", summary: "Imported GitHub repo" }, userId);
      if (!importResult.error) {
        await executeForgeTool(id, "run_preview", { summary: "Preview ready" }, userId);
      }
      const importedOutput = importResult.output as { hasIndexHtml?: boolean; imported?: number; promotedFrom?: string } | undefined;
      const msg = importResult.error
        ? `\n\nI couldn't pull that repository: ${importResult.error}`
        : importedOutput?.promotedFrom
          ? `\n\nPulled **${importedOutput.imported ?? 0}** file(s). Promoted **${importedOutput.promotedFrom}** → **index.html**. Press **Run** to preview.`
          : `\n\nPulled **${importedOutput?.imported ?? 0}** file(s). Press **Run** to preview.`;
      savedContent += msg;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
    } else {
      const det = tryDeterministicApp(content);
      if (det && isPersisted) {
        await executeForgeTool(id, "write_file", { path: det.path, content: det.content, summary: det.summary }, userId);
        await executeForgeTool(id, "run_preview", { summary: "Preview ready" }, userId);
        const msg = `\n\n${det.summary}. Press **Run** to preview.`;
        savedContent += msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      } else {
        const msg = "\n\nTry: **pull from my connected repo**, **describe my repo**, or **make a counter app**.";
        savedContent += msg;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: msg })}\n\n`);
      }
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
    }
  }

  if (isPersisted && savedContent.trim()) {
    await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent.trim() });
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
});

export default router;
