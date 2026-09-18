import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import {
  localGenerate,
  localGenerateStreaming,
  buildLocalSystemPrompt,
  isShortRequest,
  isGreeting,
  preloadLocalModel,
  localWebSearch,
  wantsImageGeneration,
  extractImagePrompt,
  localGenerateImage,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import {
  executeGithubTool,
  isGithubReady,
  listGithubRepoPublic,
  readGithubFilePublic,
  parseOwnerRepo,
  getUserGithubToken,
} from "../github-tools";
import { getAiProvider } from "../../lib/ai-provider";

void preloadLocalModel();

function toolStatusSummary(
  name: string,
  args: Record<string, unknown> = {},
  phase: "start" | "done" | "error" = "start",
): string {
  const path = String(args.path ?? args.file ?? args.filename ?? "").replace(/^\/+/, "");
  const shortPath = path ? path.split("/").pop() || path : "";
  let words: string[] = ["Working"];
  if (name === "github_list_files") words = path ? ["Listing", shortPath, "files"] : ["Listing", "repo", "files"];
  else if (name === "github_read_file") words = shortPath ? ["Reading", shortPath] : ["Reading", "file"];
  else if (name === "github_write_file") words = shortPath ? (phase === "done" ? ["Saved", shortPath] : ["Editing", shortPath]) : ["Writing", "file"];
  else if (name === "web_search") words = phase === "done" ? ["Finished", "web", "search"] : ["Searching", "the", "web"];
  else if (name === "image_gen") words = phase === "done" ? ["Image", "ready"] : ["Drawing", "your", "image"];
  else {
    const label = name.replace(/^github_/, "").replace(/_/g, " ");
    words = phase === "done" ? ["Done", label] : ["Using", label];
  }
  if (phase === "error") words = ["Failed", ...words.slice(0, 4)];
  return words.filter(Boolean).slice(0, 5).join(" ");
}

function isToolLeak(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^github_[\w]+$/.test(t)) return true;
  if (/^[\w]+_[\w_]+$/.test(t) && t.length < 60) return true;
  if (t.startsWith("{") && (t.includes('"summary"') || t.includes('"action"') || t.includes("github_"))) return true;
  return false;
}

async function streamGithubGroundedAnswer(
  res: import("express").Response,
  workingMessages: LocalChatMessage[],
  hint: string,
  items: Array<{ name?: string; path?: string; type?: string }>,
  readmeText: string | null,
  listError: string | null,
  opts: { fast: boolean; maxNewTokens: number; maxMessages: number; maxCharsPerMessage: number },
): Promise<string> {
  if (listError) {
    const errMsg = `I tried to reach **${hint || "the repo"}** but hit an error: ${listError}\n\nIf the repo is private, connect GitHub in Settings and select it, then try again.`;
    await streamText(res, errMsg);
    return errMsg;
  }

  const fileList = items
    .map((i) => `${i.name || i.path || ""}${i.type === "dir" ? "/" : ""}`)
    .filter(Boolean)
    .slice(0, 60)
    .join("\n");

  const context =
    `Here is the real, current GitHub data for ${hint || "the connected repo"} — use it to actually answer the user's question in your own words. ` +
    `Don't just dump this listing back at them unless they asked for a file listing; answer what they specifically asked, grounded in this real data.\n\n` +
    `Root files/folders:\n${fileList || "(the root is empty)"}\n` +
    (readmeText ? `\nREADME / docs content:\n${readmeText.slice(0, 3000)}` : "\n(no README or docs file was found at the root)");

  const grounded: LocalChatMessage[] = [...workingMessages, { role: "user", content: context }];

  let streamed = "";
  let reply = await localGenerateStreaming(grounded, {
    ...opts,
    onToken: (chunk) => {
      streamed += chunk;
      if (isToolLeak(streamed) && streamed.length < 80) return;
      if (!res.writableEnded && chunk) res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    },
  });

  if (isToolLeak(reply) || !reply.trim()) {
    reply = fileList
      ? `Here's what's actually at the root of ${hint || "the repo"}:\n\n${fileList}`
      : `${hint || "The repo"} appears to be empty at the root, or I couldn't read it just now — try again in a moment.`;
    await streamText(res, reply);
  }
  return reply;
}

function wantsGithubDescribe(text: string): boolean {
  const t = text.trim();
  const subject = /\b(repo|repository|app|project|this|it|axis|codebase)\b/i;
  if (/\b(describe|summary|summarize|overview|explain)\b/i.test(t) && subject.test(t)) {
    return true;
  }
  // Catches "what is X" as well as "what X is" (e.g. "what the app is"), not just the exact "what is" substring.
  if (/\bwhat\b[\s\S]*\bis\b/i.test(t) && subject.test(t)) {
    return true;
  }
  if (/\btell me about\b/i.test(t) && subject.test(t)) return true;
  if (/^describe\b/i.test(t) && t.length < 80) return true;
  if (/\bsearch\b[\s\S]*\bfiles\b/i.test(t)) return true;
  return false;
}

function looksLikeWeakRepoAnswer(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 180) {
    if (/i('m| am) (connected|using)/.test(t)) return true;
    if (/as an ai/.test(t)) return true;
    if (/don'?t have (access|the capability)/.test(t)) return true;
    if (/web browser/.test(t)) return true;
    if (/github repository of/.test(t)) return true;
  }
  // Generic, ungrounded product-blurb phrasing the model reaches for when it has no real file data —
  // a giveaway that it's guessing rather than describing anything it actually looked at.
  if (/\b(is a (web-based|cloud-based) tool|is a platform that|is designed to (help|allow)|allows users to (create|edit|share|manage))\b/.test(t)) {
    return true;
  }
  return false;
}

const router: IRouter = Router();

async function loadMemories(userId: number): Promise<string> {
  const rows = await db.select().from(userMemories).where(eq(userMemories.userId, userId)).orderBy(desc(userMemories.createdAt)).limit(30);
  if (rows.length === 0) return "";
  return rows.map((r) => r.content).join("\n");
}

async function generateTitle(userMessage: string): Promise<string> {
  try {
    const raw = (await localGenerate(
      [
        { role: "system", content: "Reply with only a short chat title." },
        { role: "user", content: `Title (2-5 words) for: "${userMessage.slice(0, 300)}"` },
      ],
      { maxNewTokens: 24, maxMessages: 2, maxCharsPerMessage: 400, fast: true },
    )).trim();
    const candidate = raw.replace(/^["']|["'.,!?]$/g, "").trim();
    if (candidate && candidate.length > 1 && candidate.length < 80) return candidate;
  } catch { /* ignore */ }
  return "New Chat";
}

async function streamText(res: import("express").Response, text: string): Promise<void> {
  if (res.writableEnded) return;
  for (let i = 0; i < text.length; i += 256) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ content: text.slice(i, i + 256) })}\n\n`);
  }
}

router.get("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db.select().from(conversations).where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId)).orderBy(desc(conversations.createdAt));
  res.json(result.filter((c) => c.source === "axis").map((c) => ({ id: c.id, title: c.title, language: c.language, createdAt: c.createdAt })));
});

router.post("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New Chat", language = "TypeScript" } = req.body as { title?: string; language?: string };
  if (!userId) {
    res.status(201).json({ id: -1, title, language, createdAt: new Date().toISOString() });
    return;
  }
  const [created] = await db.insert(conversations).values({ title, language, source: "axis", userId }).returning();
  res.status(201).json({ id: created.id, title: created.title, language: created.language, createdAt: created.createdAt });
});

router.get("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({ id: conv.id, title: conv.title, language: conv.language, createdAt: conv.createdAt, messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })) });
});

router.patch("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, language: updated.language, createdAt: updated.createdAt });
});

router.delete("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })));
});

router.post("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, planMode = false, language: bodyLanguage, guestHistory: rawGuestHistory } = req.body as {
    content: string; planMode?: boolean; language?: string; guestHistory?: Array<{ role: string; content: string }>;
  };
  const guestHistory = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;

  let convLanguage = bodyLanguage ?? "TypeScript";
  if (userId && id > 0) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    convLanguage = conv.language;
  }

  const history: Array<{ role: string; content: string }> = (userId && id > 0)
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (userId && id > 0) await db.insert(messages).values({ conversationId: id, role: "user", content });

  const memoryBlock = userId ? await loadMemories(userId) : "";

  if (getAiProvider() !== "local") {
    res.status(500).json({ error: "Set AXIS_AI_PROVIDER=local" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ status: "thinking", summary: "Thinking it through" })}\n\n`);

    const localSystem = [
      buildLocalSystemPrompt(convLanguage),
      memoryBlock ? `Known about this user:\n${memoryBlock.slice(0, 400)}` : "",
      planMode ? "PLAN MODE: help plan only." : "",
      "Never refuse normal coding or GitHub questions.",
      "Never say you lack access to the user's connected repo when tools or prior pulls provided file lists.",
      "Never reply with only a tool name like github_list_files.",
    ].filter(Boolean).join("\n\n");

    const short = isShortRequest(content);
    const greeting = isGreeting(content);
    const historySlice = greeting || short ? history.slice(-2) : history.slice(-4);
    const localMessages: LocalChatMessage[] = [
      { role: "system", content: localSystem },
      ...historySlice.map((m): LocalChatMessage => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content.replace(/\[IMAGE:[^\]]*\]/g, "[image]").slice(0, greeting ? 300 : short ? 500 : 1200),
      })),
      { role: "user", content: content.slice(0, greeting ? 200 : short ? 800 : 1600) },
    ];
    const workingMessages = [...localMessages];
    let reply = "";
    const sources: Array<{ url: string; title: string }> = [];

    if (wantsImageGeneration(content)) {
      const toolId = `${Date.now()}-image`;
      const imgPrompt = extractImagePrompt(content);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "image_gen", summary: "Drawing your image" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ generatingImage: true })}\n\n`);
      }
      try {
        const { b64, mimeType } = await localGenerateImage(imgPrompt);
        reply = `Here's an image for: ${imgPrompt}`;
        await streamText(res, reply);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ imageData: { b64, mimeType } })}\n\n`);
          res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: "Image ready" } })}\n\n`);
        }
        if (userId && id > 0) await db.insert(messages).values({ conversationId: id, role: "assistant", content: `${reply}\n\n[IMAGE:${mimeType}|${b64}]` });
        if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Image failed", error: message } })}\n\n`);
      }
    }

    const parsedRepoInText = parseOwnerRepo(content);
    // Don't gate on how the question is phrased — if GitHub is connected (or a specific
    // owner/repo was named), ground every non-greeting reply in real data and let the
    // model itself decide whether/how to use it, rather than requiring keyword matches.
    const wantsGithubTool = !greeting && (!!parsedRepoInText || (!!userId && (await isGithubReady(userId))));
    const wantsWebSearch = /\b(search the web|look up online|current price|latest news|weather today)\b/i.test(content);

    if (wantsWebSearch) {
      const toolId = `${Date.now()}-web`;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "web_search", summary: "Searching the web" } })}\n\n`);
      try {
        const search = await localWebSearch(content);
        for (const s of search.sources) sources.push({ url: s.url, title: s.title });
        workingMessages.push({ role: "user", content: `Live web search results:\n${JSON.stringify(search.sources).slice(0, 2000)}` });
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: "Finished web search" } })}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Search failed", error: message } })}\n\n`);
      }
    }

    if (wantsGithubTool) {
      const parsed = parseOwnerRepo(content);
      let listed: { output?: unknown; error?: string };
      let hint = "your connected repo";

      const listId = `${Date.now()}-list`;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolStart: { id: listId, name: "github_list_files", summary: "Listing repo files" } })}\n\n`);
      }

      const userToken = await getUserGithubToken(userId);

      if (parsed) {
        hint = `${parsed.owner}/${parsed.repo}`;
        listed = await listGithubRepoPublic(parsed.owner, parsed.repo, "", "main", userToken);
        if (listed.error && userId && userToken) {
          listed = await executeGithubTool(userId, "github_list_files", {
            path: "",
            owner: parsed.owner,
            repo: parsed.repo,
          });
        }
      } else if (userId && (await isGithubReady(userId))) {
        listed = await executeGithubTool(userId, "github_list_files", { path: "" });
      } else {
        listed = {
          error: userToken
            ? "Name a repo like owner/name (e.g. methatsmeyesitsme/Axis)."
            : "Connect GitHub with a PAT in Settings (needs repo scope), then try again.",
        };
      }

      if (!res.writableEnded) {
        const summary = toolStatusSummary("github_list_files", {}, listed.error ? "error" : "done");
        res.write(`data: ${JSON.stringify(listed.error ? { toolError: { id: listId, summary, error: listed.error } } : { toolDone: { id: listId, summary } })}\n\n`);
      }

      const items = Array.isArray(listed.output)
        ? (listed.output as Array<{ name?: string; path?: string; type?: string }>)
        : [];

      let readmeText: string | null = null;
      const readme = items.find((i) => /readme/i.test(String(i.path ?? i.name ?? "")) && i.type !== "dir");
      const altDoc = !readme
        ? items.find((i) => /^(replit\.md|readme\.md|readme)$/i.test(String(i.name ?? i.path ?? "")) && i.type !== "dir")
        : undefined;
      const docPath = readme?.path || altDoc?.path;
      if (docPath && !listed.error) {
        const readId = `${Date.now()}-readme`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: readId, name: "github_read_file", summary: "Reading project docs" } })}\n\n`);
        }
        let read: { output?: unknown; error?: string };
        if (parsed) {
          read = await readGithubFilePublic(parsed.owner, parsed.repo, docPath, "main", userToken);
        } else if (userId) {
          read = await executeGithubTool(userId, "github_read_file", { path: docPath });
        } else {
          read = { error: "Not connected" };
        }
        if (!res.writableEnded) {
          const summary = toolStatusSummary("github_read_file", { path: docPath }, read.error ? "error" : "done");
          res.write(`data: ${JSON.stringify(read.error ? { toolError: { id: readId, summary, error: read.error } } : { toolDone: { id: readId, summary } })}\n\n`);
        }
        if (!read.error && typeof read.output === "string") readmeText = read.output;
      }

      reply = await streamGithubGroundedAnswer(res, workingMessages, hint, items, readmeText, listed.error ?? null, {
        fast: short || greeting,
        maxNewTokens: greeting ? 60 : short ? 250 : 900,
        maxMessages: greeting ? 2 : short ? 3 : 6,
        maxCharsPerMessage: greeting ? 300 : short ? 600 : 1400,
      });
    } else {
      let streamed = "";
      reply = await localGenerateStreaming(workingMessages, {
        fast: short || greeting,
        maxNewTokens: greeting ? 48 : short ? 96 : 900,
        maxMessages: greeting ? 2 : short ? 3 : 6,
        maxCharsPerMessage: greeting ? 300 : short ? 600 : 1400,
        onToken: (chunk) => {
          streamed += chunk;
          if (isToolLeak(streamed) && streamed.length < 80) return;
          if (!res.writableEnded && chunk) res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        },
      });
      if (isToolLeak(reply)) {
        reply = "I couldn't answer that cleanly. Try asking again, or name a GitHub repo like owner/name.";
        await streamText(res, reply);
      }

      const shouldForceGithub =
        (wantsGithubDescribe(content) || /\b(repo|repository|connected|github)\b/i.test(content)) &&
        looksLikeWeakRepoAnswer(reply) &&
        !!userId;
      if (shouldForceGithub) {
        console.log("[openai] weak model answer for repo question — forcing GitHub describe");
        const listId2 = `${Date.now()}-force-list`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: listId2, name: "github_list_files", summary: "Listing repo files" } })}\n\n`);
        }
        const userToken2 = await getUserGithubToken(userId);
        let listed2: { output?: unknown; error?: string };
        if (await isGithubReady(userId)) {
          listed2 = await executeGithubTool(userId, "github_list_files", { path: "" });
        } else {
          listed2 = { error: userToken2 ? "Select a connected repo in Settings." : "Connect GitHub (PAT with repo scope) in Settings." };
        }
        if (!res.writableEnded) {
          const summary = toolStatusSummary("github_list_files", {}, listed2.error ? "error" : "done");
          res.write(`data: ${JSON.stringify(listed2.error ? { toolError: { id: listId2, summary, error: listed2.error } } : { toolDone: { id: listId2, summary } })}\n\n`);
        }
        const items2 = Array.isArray(listed2.output)
          ? (listed2.output as Array<{ name?: string; path?: string; type?: string }>)
          : [];
        let readme2: string | null = null;
        const doc2 = items2.find((i) => /readme|replit\.md/i.test(String(i.path ?? i.name ?? "")) && i.type !== "dir");
        if (doc2?.path && !listed2.error) {
          const read = await executeGithubTool(userId, "github_read_file", { path: doc2.path });
          if (!read.error && typeof read.output === "string") readme2 = read.output;
        }
        reply = await streamGithubGroundedAnswer(res, workingMessages, "your connected repo", items2, readme2, listed2.error ?? null, {
          fast: false,
          maxNewTokens: 500,
          maxMessages: 6,
          maxCharsPerMessage: 1400,
        });
      }
    }

    if (sources.length > 0 && !res.writableEnded) res.write(`data: ${JSON.stringify({ sources })}\n\n`);

    if (history.length === 0 && userId && id > 0) {
      const newTitle = await generateTitle(content);
      await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
    }

    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    if (userId && id > 0 && reply && !isToolLeak(reply)) {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: reply });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
