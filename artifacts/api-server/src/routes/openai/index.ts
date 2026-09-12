import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
import {
  localGenerate,
  localAgentTurn,
  buildLocalToolResultMessage,
  buildLocalSystemPrompt,
  localWebSearch,
  toLocalToolDefinitions,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { githubToolDeclarations, executeGithubTool, isGithubReady } from "../github-tools";
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
import { getAiProvider } from "../../lib/ai-provider";

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
    const prompt = `Create a short, specific title (2-5 words) for a chat that starts with this message. Rules: be specific about the actual topic (e.g. "React useState Hook Bug", "Python CSV Parser", "Sort Algorithm Comparison"), use Title Case, no quotes, no punctuation at the end. Reply with ONLY the title.\n\nMessage: "${userMessage.slice(0, 500)}"`;
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
    log?.error({ raw, candidate }, "[Axis] generateTitle: candidate rejected");
  } catch (e) {
    log?.error({ err: e }, "[Axis] generateTitle: exception");
  }
  return "New Chat";
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "axis").map((c) => ({
      id: c.id,
      title: c.title,
      language: c.language,
      createdAt: c.createdAt,
    }))
  );
});

router.post("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New Chat", language = "TypeScript" } = req.body as { title?: string; language?: string };
  if (!userId) {
    res.status(201).json({ id: -1, title, language, createdAt: new Date().toISOString() });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title, language, source: "axis", userId })
    .returning();
  res.status(201).json({
    id: created.id,
    title: created.title,
    language: created.language,
    createdAt: created.createdAt,
  });
});

router.get("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({
    id: conv.id, title: conv.title, language: conv.language, createdAt: conv.createdAt,
    messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })),
  });
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
  const { content, planMode = false, language: bodyLanguage, guestHistory: rawGuestHistory } = req.body as { content: string; planMode?: boolean; language?: string; guestHistory?: Array<{role: string; content: string}> };
  const guestHistory: Array<{role: string; content: string}> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;

  let convLanguage = bodyLanguage ?? "TypeScript";
  if (userId && id > 0) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    convLanguage = conv.language;
  }

  const history: Array<{role: string; content: string}> = (userId && id > 0)
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (userId && id > 0) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
  }

  const memoryBlock = userId ? await loadMemories(userId) : "";

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  let systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.\n\nYou are Axis, an expert AI programming assistant created by CodeGen, specializing in ${convLanguage}.\n\nCORE IDENTITY:\n- You are Axis — brilliant, precise, and friendly. You make complex code feel approachable.\n- You specialize in ${convLanguage} but are fluent in all major programming languages.\n- You think like a senior engineer and teach like a great mentor.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}\n\nCORE BEHAVIOR:\n1. When a user shares or pastes code WITHOUT a specific request:\n   - Describe what the code does at a high level first\n   - Walk through the key parts with clear, accessible explanations\n   - Point out any issues, inefficiencies, or improvements you notice\n\n2. When a user asks to FIX or DEBUG code:\n   - Step 1: Identify ALL bugs/issues clearly and specifically\n   - Step 2: Explain WHY each is a problem in plain language\n   - Step 3: Show the corrected, fully-working code\n   - Step 4: Briefly explain what changed and why\n\n3. When GENERATING new code:\n   - Write production-quality, clean, well-commented ${convLanguage} code\n   - Follow best practices and idioms for ${convLanguage}\n   - Include error handling where appropriate\n   - After the code, explain how it works and key design decisions\n\n4. Always format code in markdown code blocks with the correct language tag.\n\n5. Communication style: Clear and beginner-friendly, use **bold** for key terms, numbered lists for steps.\n\n6. If the user's message contains \"[POSSIBLE SYNTAX ISSUES DETECTED]\", acknowledge and fix those issues.\n\n7. Always offer a follow-up: suggest what to build next or ask if they want a deeper explanation.`;

  if (planMode) {
    systemPrompt += `\n\nPLAN MODE IS ACTIVE — Help the user plan, not implement. Use pseudocode only. End with a question that moves planning forward.`;
  }

  // ── LOCAL PROVIDER (last-resort backup) ───────────────────────────────────
  if (getAiProvider() === "local") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const localSystem = [
        buildLocalSystemPrompt(convLanguage),
        systemPrompt,
        "IMAGE GENERATION IS NOT AVAILABLE in the free local mode. Explain that clearly if asked; do not emit an IMAGE_PROMPT tag.",
        "If a current fact, price, news item, or other live information is needed, call web_search before answering.",
      ].join("\n\n");
      const localMessages: LocalChatMessage[] = [
        { role: "system", content: localSystem },
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
      let reply = "";
      const sources: Array<{ url: string; title: string }> = [];
      const wantsGithubTool = /\b(github|repository|repo|branch|pull request|commit|connected (?:repo|repository)|read (?:the )?file|write (?:the )?file)\b/i.test(content);
      const wantsWebSearch = /\b(search the web|look up|current|latest|today|news|recent|price|weather|stock)\b/i.test(content);
      const localTools = [
        ...(wantsGithubTool ? toLocalToolDefinitions(githubToolDeclarations) : []),
        ...(wantsWebSearch ? [{
          name: "web_search",
          description: "Search the live web for current information and return source URLs.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "The focused web search query" } },
            required: ["query"],
          },
        }] : []),
      ];

      if (localTools.length === 0) {
        reply = await localGenerate(workingMessages, { maxNewTokens: 1400, maxMessages: 8, maxCharsPerMessage: 2400 });
      } else {
        for (let turn = 0; turn < 8; turn++) {
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
          if (decision.name === "web_search") {
            try {
              const search = await localWebSearch(String(decision.arguments.query ?? ""));
              result = { output: search.sources };
              for (const source of search.sources) sources.push({ url: source.url, title: source.title });
            } catch (error) {
              result = { error: error instanceof Error ? error.message : String(error) };
            }
          } else if (userId && (await isGithubReady(userId))) {
            result = await executeGithubTool(userId, decision.name, decision.arguments);
          } else {
            result = { error: "No GitHub repository is connected/selected. Ask the person to connect GitHub and pick a repo in Settings." };
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

      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: savedContent })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      }

      if (userId && id > 0 && savedContent) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }
    } catch (err) {
      const msg = friendlyGeminiErrorMessage(err, "Local model failed to generate a response");
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // ── GEMINI PATH ─────────────────────────────────────────────────────────────

  const { text: currentText, imageParts: currentImageParts } = extractImageParts(content);
  const chatMessages: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" as const : ("user" as const),
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

  if (userId && (await isGithubReady(userId))) {
    let toolRounds = 4;
    while (toolRounds-- > 0) {
      const toolCheck = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: chatMessages,
        config: {
          systemInstruction: `${systemPrompt}\n\nIf the person is asking about the code in their connected GitHub repository, use the github_* tools to read or write real files before answering. Otherwise, don't call these tools — just answer normally.`,
          tools: [{ functionDeclarations: githubToolDeclarations }],
        },
      });
      const calls = toolCheck.functionCalls;
      if (!calls?.length) break;
      chatMessages.push({ role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
      const responseParts: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        const result = await executeGithubTool(userId, call.name ?? "", (call.args ?? {}) as Record<string, unknown>);
        responseParts.push({
          functionResponse: { name: call.name, response: result.error ? { error: result.error } : { output: result.output ?? "ok" } },
        });
      }
      chatMessages.push({ role: "user", parts: responseParts });
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

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
      const imagePromptStart = fullResponse.search(/\[IMAGE_PROMPT/i);
      const hasImagePrompt = imagePromptStart >= 0;
      let savedContent = hasImagePrompt
        ? fullResponse.slice(0, imagePromptStart).trimEnd()
        : fullResponse;

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

      const sources = lastGroundingChunks
        .filter((c) => c.web?.uri)
        .map((c) => ({ url: c.web!.uri, title: c.web!.title ?? c.web!.uri }));
      if (sources.length > 0 && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      }

      if (userId && id > 0 && savedContent) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
  } catch (err) {
    const msg = friendlyGeminiErrorMessage(err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
