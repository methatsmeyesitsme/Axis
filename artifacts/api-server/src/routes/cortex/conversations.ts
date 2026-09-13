import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
import {
  localGenerate,
  localAgentTurn,
  buildLocalToolResultMessage,
  localWebSearch,
  toLocalToolDefinitions,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";
import { githubToolDeclarations, executeGithubTool, isGithubReady } from "../github-tools";

const router: IRouter = Router();

// ── MIME map ─────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
  yaml: "application/yaml",
  yml: "application/yaml",
  tsv: "text/tab-separated-values",
};

function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? "text/plain";
}

// Pulls any [IMAGE:mimeType|base64] markers out of a user message so they can be
// sent to Gemini as real inlineData parts (i.e. the model can actually see them),
// rather than as a giant base64 text blob.
function extractImageParts(content: string): {
  text: string;
  imageParts: Array<{ inlineData: { mimeType: string; data: string } }>;
} {
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  const text = content
    .replace(/\[IMAGE:([^|]+)\|([^\]]+)\]/g, (_, mimeType: string, b64: string) => {
      imageParts.push({ inlineData: { mimeType: mimeType.trim(), data: b64.trim() } });
      return "";
    })
    .trim();
  return { text, imageParts };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadMemories(userId: number): Promise<string> {
  const rows = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt))
    .limit(30);
  if (rows.length === 0) return "";
  return rows.map((r) => r.content).join("\n");
}

async function extractAndSaveMemories(userId: number, userMessage: string): Promise<void> {
  try {
    const prompt = `Extract personal facts about the user from this message. Only extract clear, first-person facts (name, age, job, location, preferences, etc.). If there are no personal facts, reply with exactly: NONE\n\nMessage: "${userMessage.slice(0, 500)}"\n\nReply with one fact per line, or NONE.`;
    const text = getAiProvider() === "local"
      ? (await localGenerate([
          { role: "system", content: "You extract memory facts. Reply with facts or exactly NONE." },
          { role: "user", content: prompt },
        ], { maxNewTokens: 100, maxMessages: 2, maxCharsPerMessage: 1200 })).trim()
      : (await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 100 },
        })).text?.trim() ?? "";
    if (!text || text === "NONE") return;
    const facts = text.split("\n").map((f) => f.trim()).filter((f) => f && f !== "NONE");
    for (const fact of facts) {
      await db.insert(userMemories).values({ userId, content: fact });
    }
    const all = await db
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(desc(userMemories.createdAt));
    if (all.length > 30) {
      const toDelete = all.slice(30).map((r) => r.id);
      for (const id of toDelete) {
        await db.delete(userMemories).where(eq(userMemories.id, id));
      }
    }
  } catch {
    // Memory extraction is best-effort
  }
}

async function generateTitle(userMessage: string, log?: { error: (o: unknown, m: string) => void }): Promise<string> {
  try {
    const prompt = `Create a short, specific title (2-5 words) for a conversation that starts with this message. Rules: be specific about the actual topic (e.g. "Explain Quantum Entanglement", "Best Budget Laptops 2026", "Roman Empire Timeline", "Fix Sleep Schedule"), use Title Case, no quotes, no punctuation at the end. Reply with ONLY the title.\n\nMessage: "${userMessage.slice(0, 500)}"`;
    const raw = getAiProvider() === "local"
      ? (await localGenerate([
          { role: "system", content: "Create concise chat titles. Reply with only the title." },
          { role: "user", content: prompt },
        ], { maxNewTokens: 50, maxMessages: 2, maxCharsPerMessage: 1200 })).trim()
      : (await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 50, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
        })).text?.trim() ?? "";
    const candidate = raw.replace(/^["']|["'.,!?]$/g, "").trim();
    if (candidate && candidate.length > 1 && candidate.length < 80) return candidate;
    log?.error({ raw, candidate }, "[Cortex] generateTitle: candidate rejected");
  } catch (e) {
    log?.error({ err: e }, "[Cortex] generateTitle: exception");
  }
  return "New Chat";
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "cortex").map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
    }))
  );
});

router.post("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New Chat" } = req.body as { title?: string };
  if (!userId) {
    // Guest: return a virtual conversation (nothing written to DB)
    res.status(201).json({ id: -1, title, createdAt: new Date().toISOString() });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title, language: "General", source: "cortex", userId })
    .returning();
  res.status(201).json({ id: created.id, title: created.title, createdAt: created.createdAt });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") { res.status(404).json({ error: "Conversation not found" }); return; }
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
  if (!conv || conv.source !== "cortex") { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, createdAt: updated.createdAt });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") { res.status(404).json({ error: "Conversation not found" }); return; }
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

  // Validate conversation for authenticated users (guests use virtual id=-1)
  if (userId && id > 0) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "cortex") { res.status(404).json({ error: "Conversation not found" }); return; }
  }

  // History: DB for authenticated users, in-body for guests
  const history: Array<{role: string; content: string}> = (userId && id > 0)
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  // Only persist user message for authenticated users
  if (userId && id > 0) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
  }

  const memoryBlock = userId ? await loadMemories(userId) : "";

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.

You are Cortex, an advanced AI assistant created by CodeGen. You are knowledgeable, thoughtful, and helpful across all topics — from science, math, writing, and history to creative projects, coding help, life advice, and everything in between.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}

CORE BEHAVIOR:
1. Give clear, accurate, well-structured answers. Use examples, analogies, and step-by-step reasoning when helpful.
2. Adapt your tone to the user — casual and friendly for general questions, precise and technical when the topic demands it.
3. For complex questions, break your answer into clear sections or steps.
4. When you're uncertain, say so clearly and explain what you do know.
5. Be honest, balanced, and thoughtful. Never be preachy or condescending.
6. Format responses with markdown when it improves readability.
7. For math and logic problems, show your work step-by-step.
8. Be concise when the answer is simple; go deeper when the question requires it.

WEB SEARCH: You have access to real-time Google Search. Use it automatically for current prices, news, recent events, product info, stock prices, weather, or any question requiring up-to-date data. Always include the source URL when citing search results.

IMAGE GENERATION: When the user asks you to generate, create, draw, make, or show an image, picture, illustration, photo, or artwork, include this tag on its own line:
[IMAGE_PROMPT: a detailed visual description of the image]
The image will be generated automatically. Do not use ASCII art.
IMPORTANT: this tag MUST be the very last thing in your entire response — everything after it is discarded. If you also need to write text or generate a file in the same response, write the text and the [FILE: ...] block FIRST, and put [IMAGE_PROMPT: ...] last, after them.

FILE GENERATION: When the user asks for a downloadable file (CSV, spreadsheet, text file, data file, etc.), use this exact format — the marker on one line, then immediately the code block:
[FILE: filename.ext]
\`\`\`ext
file content here
\`\`\`
Use the correct file extension (.csv for spreadsheets, .txt for text, .json for JSON, etc.). The user will get a direct download button.

COMBINING ACTIONS: You are not limited to one action per response. If a request calls for it, a single response can include written text, a generated file, AND a generated image together — write your explanation, then any [FILE: ...] block(s), and finish with [IMAGE_PROMPT: ...] last (per the ordering rule above).`;

  // Strip huge embedded data from history so Gemini context stays manageable
  const { text: currentText, imageParts: currentImageParts } = extractImageParts(content);
  const chatMessages = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : ("user" as "model" | "user"),
      parts: [{
        text: m.content
          .replace(/\[IMAGE:[^\]]*\]/g, "[image was attached here]")
          .replace(/\[FILEDATA:[^\]]*\]/g, "[file was generated here]"),
      }],
    })),
    {
      role: "user" as const,
      parts: [
        ...currentImageParts,
        { text: currentText || "Please look at the attached image." },
      ],
    },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (getAiProvider() === "local") {
    try {
      const localMessages: LocalChatMessage[] = [
        {
          role: "system",
          content: `${systemPrompt}\n\nIMAGE GENERATION IS NOT AVAILABLE in the free local mode. Explain that clearly if asked; do not emit an IMAGE_PROMPT tag.\nIf current information is needed, use the web_search tool first.`,
        },
        ...history.slice(-4).map((m): LocalChatMessage => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content
            .replace(/\[IMAGE:[^\]]*\]/g, "[image]")
            .replace(/\[FILEDATA:[^\]]*\]/g, "[file]")
            .slice(0, 1800),
        })),
        { role: "user", content: content.slice(0, 2400) },
      ];
      const workingMessages = [...localMessages];
      const sources: Array<{ url: string; title: string }> = [];
      let reply = "";
      const wantsWebSearch = /\b(search the web|look up|current|latest|today|news|recent|price|weather|stock)\b/i.test(content);
      const wantsGithubTool =
        /\b(github|my repo|the repo|repository|pull request|\bPR\b|commit to|list files|read file|write file|pull from|clone|what is this repo|tell me what it is)\b/i.test(content) ||
        /\b[\w.-]+\/[\w.-]+\b/.test(content);
      const localTools = [...(wantsGithubTool ? toLocalToolDefinitions(githubToolDeclarations) : [])];

      if (wantsWebSearch) {
        const toolId = `${Date.now()}-web-search`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "web_search", summary: "Searched the live web" } })}\n\n`);
        }
        try {
          const search = await localWebSearch(content);
          for (const source of search.sources) sources.push({ url: source.url, title: source.title });
          workingMessages.push({
            role: "user",
            content: [
              "Authoritative live web search results. Use these results rather than inventing current facts.",
              JSON.stringify(search.sources),
              "Cite relevant URLs in the answer.",
            ].join("\n"),
          });
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: "Searched the live web" } })}\n\n`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          workingMessages.push({ role: "user", content: `The live web search failed: ${message}. Say that current sources were unavailable.` });
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Searched the live web", error: message } })}\n\n`);
          }
        }
      }

      if (localTools.length === 0) {
        reply = await localGenerate(workingMessages, { maxNewTokens: 1400, maxMessages: 8, maxCharsPerMessage: 2400 });
      } else {
        for (let turn = 0; turn < 6; turn++) {
          const decision = await localAgentTurn(workingMessages, localTools, { maxNewTokens: 1200 });
          if (decision.kind === "final") {
            reply = decision.content;
            break;
          }

          const toolId = `${Date.now()}-${turn}`;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: decision.name, summary: `Used ${decision.name}` } })}\n\n`);
          }

          let result: { output?: unknown; error?: string };
          if (userId && (await isGithubReady(userId))) {
            result = await executeGithubTool(userId, decision.name, decision.arguments);
          } else {
            result = { error: "No GitHub repository is connected/selected. Connect GitHub in Settings and select a repo, then try again." };
          }
          if (!res.writableEnded) {
            const event = result.error
              ? { toolError: { id: toolId, summary: `Used ${decision.name}`, error: result.error } }
              : { toolDone: { id: toolId, summary: `Used ${decision.name}` } };
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          workingMessages.push({
            role: "assistant",
            content: JSON.stringify({ action: "tool", name: decision.name, arguments: decision.arguments }),
          });
          workingMessages.push({ role: "user", content: buildLocalToolResultMessage(decision.name, result) });
        }
      }

      const fileBlockRe = /\[FILE:\s*([^\]\n]+)\]\s*\n```[\w-]*\n([\s\S]*?)```/gi;
      let savedContent = reply.replace(fileBlockRe, (_, rawName: string, fileContent: string) => {
        const filename = rawName.trim();
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeType = getMimeType(ext);
        const b64 = Buffer.from(fileContent).toString("base64");
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ fileData: { filename, b64, mimeType } })}\n\n`);
        }
        return `[FILEDATA: ${filename}|${mimeType}|${b64}]`;
      });
      if (sources.length > 0 && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      }
      if (history.length === 0 && userId && id > 0) {
        const newTitle = await generateTitle(content, req.log);
        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
      }
      if (userId) extractAndSaveMemories(userId, content).catch(() => {});
      if (userId && id > 0 && savedContent) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: savedContent })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    } catch (err) {
      const friendlyMessage = friendlyGeminiErrorMessage(err, "Local model failed to generate a response");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
        res.end();
      }
    }
    return;
  }

  let fullResponse = "";

  try {
    const stream = await ai.models.generateContentStream({
      model: "gemini-3.6-flash",
      contents: chatMessages,
      config: {
        maxOutputTokens: 8192,
        systemInstruction: systemPrompt,
        tools: [{ googleSearch: {} }],
      },
    });

    let lastGroundingChunks: Array<{ web?: { uri: string; title?: string } }> = [];
    let generatingImageNotified = false;

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        // Notify client as soon as [IMAGE_PROMPT appears — long before image gen starts
        if (!generatingImageNotified && fullResponse.search(/\[IMAGE_PROMPT/i) >= 0) {
          generatingImageNotified = true;
          res.write(`data: ${JSON.stringify({ generatingImage: true })}\n\n`);
        }
      }
      const meta = (chunk as unknown as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title?: string } }> } }> })
        .candidates?.[0]?.groundingMetadata;
      if (meta?.groundingChunks?.length) lastGroundingChunks = meta.groundingChunks;
    }

    if (!res.writableEnded) {
      // ── 1. Strip [IMAGE_PROMPT:...] from displayed text ───────────────────
      // Use string search so we don't require a closing ']' (model sometimes omits it)
      const imagePromptStart = fullResponse.search(/\[IMAGE_PROMPT/i);
      const hasImagePrompt = imagePromptStart >= 0;
      let savedContent = hasImagePrompt
        ? fullResponse.slice(0, imagePromptStart).trimEnd()
        : fullResponse;
      // Extract the prompt text (with or without closing bracket)
      const imagePromptText = hasImagePrompt
        ? (fullResponse.slice(imagePromptStart).match(/\[IMAGE_PROMPT:\s*([\s\S]+?)(?:\]|$)/i)?.[1]?.trim() ?? null)
        : null;

      // ── 2. Process [FILE: filename.ext] + code block → fileData events ────
      const fileBlockRe = /\[FILE:\s*([^\]\n]+)\]\s*\n```[\w-]*\n([\s\S]*?)```/gi;
      savedContent = savedContent.replace(fileBlockRe, (_, rawName: string, fileContent: string) => {
        const filename = rawName.trim();
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeType = getMimeType(ext);
        const b64 = Buffer.from(fileContent).toString("base64");
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ fileData: { filename, b64, mimeType } })}\n\n`);
        }
        return `[FILEDATA: ${filename}|${mimeType}|${b64}]`;
      });

      // ── 3. Send grounding sources ─────────────────────────────────────────
      const sources = lastGroundingChunks
        .filter((c) => c.web?.uri)
        .map((c) => ({ url: c.web!.uri, title: c.web!.title ?? c.web!.uri }));
      if (sources.length > 0 && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      }

      // ── 4. Generate title FIRST (fast, before slow image gen) ─────────────
      const isFirstMessage = history.length === 0;
      if (isFirstMessage && userId && id > 0) {
        const newTitle = await generateTitle(content, req.log);
        req.log.info({ newTitle }, "[Cortex] title generated");
        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
        }
      }

      // ── 5. Generate image (slow — generatingImage already sent during stream) ──
      if (hasImagePrompt && imagePromptText) {
        try {
          const imgResult = await generateImage(imagePromptText);
          savedContent += `\n[IMAGE:${imgResult.mimeType}|${imgResult.b64_json}]`;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ imageData: { b64: imgResult.b64_json, mimeType: imgResult.mimeType } })}\n\n`);
          }
        } catch (imgErr) {
          req.log.error({ imgErr }, "[Cortex] Image generation failed");
          const failureNote = "\n\n_Sorry, I wasn't able to generate that image just now — please try again._";
          savedContent += failureNote;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ imageFailed: true, content: failureNote })}\n\n`);
          }
        }
      }

      // ── 6. Persist assistant message (authenticated only) ─────────────────
      if (userId && id > 0) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }

      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }

      if (userId) {
        extractAndSaveMemories(userId, content).catch(() => {});
      }
    }
  } catch (err) {
    req.log.error({ err }, "[Cortex] Gemini error");
    const friendlyMessage = friendlyGeminiErrorMessage(err);
    if (userId && id > 0) {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: friendlyMessage }).catch(() => {});
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: friendlyMessage })}\n\n`);
      res.end();
    }
  }
});

export default router;
