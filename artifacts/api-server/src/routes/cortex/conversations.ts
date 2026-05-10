import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
import { eq, desc, isNull } from "drizzle-orm";

const router: IRouter = Router();

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
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [{
          text: `Extract personal facts about the user from this message. Only extract clear, first-person facts (name, age, job, location, preferences, etc.). If there are no personal facts, reply with exactly: NONE\n\nMessage: "${userMessage.slice(0, 500)}"\n\nReply with one fact per line, or NONE.`,
        }],
      }],
      config: { maxOutputTokens: 100 },
    });
    const text = response.text?.trim() ?? "";
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
  const { title = "New Chat" } = req.body as { title?: string };
  const userId = req.session?.userId ?? null;
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
  const { content } = req.body as { content: string };

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") { res.status(404).json({ error: "Conversation not found" }); return; }

  const history = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

  await db.insert(messages).values({ conversationId: id, role: "user", content });

  const userId = req.session?.userId ?? null;
  const memoryBlock = userId ? await loadMemories(userId) : "";

  const systemPrompt = `You are Cortex, an advanced AI assistant created by CodeGen. You are knowledgeable, thoughtful, and helpful across all topics — from science, math, writing, and history to creative projects, coding help, life advice, and everything in between.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}

CORE BEHAVIOR:
1. Give clear, accurate, well-structured answers. Use examples, analogies, and step-by-step reasoning when helpful.
2. Adapt your tone to the user — casual and friendly for general questions, precise and technical when the topic demands it.
3. For complex questions, break your answer into clear sections or steps.
4. When you're uncertain, say so clearly and explain what you do know.
5. Be honest, balanced, and thoughtful. Never be preachy or condescending.
6. Format responses with markdown when it improves readability.
7. For math and logic problems, show your work step-by-step.
8. Be concise when the answer is simple; go deeper when the question requires it.

IMAGE GENERATION: When the user asks you to generate, create, draw, make, or show an image, picture, illustration, photo, or artwork, you MUST include this tag on its own line at the very end of your response:
[IMAGE_PROMPT: a detailed visual description of the image]
Do not use ASCII art. Just include the tag — the image will be generated automatically.

FILE GENERATION: When the user asks for a .txt or text file, put the content in a \`\`\`text code block. For CSV data or spreadsheets, use a \`\`\`csv code block. The user can download these files directly from the code block.`;

  const chatMessages = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : ("user" as "model" | "user"),
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: content }] },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let fullResponse = "";

  try {
    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: chatMessages,
      config: { maxOutputTokens: 8192, systemInstruction: systemPrompt },
    });

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (!res.writableEnded) {
      // Detect and process image generation request
      const imagePromptMatch = fullResponse.match(/\[IMAGE_PROMPT:\s*([\s\S]+?)\]\s*$/i);
      let savedContent = fullResponse;

      if (imagePromptMatch) {
        const imagePrompt = imagePromptMatch[1].trim();
        savedContent = fullResponse.slice(0, imagePromptMatch.index).trimEnd();
        try {
          const imgResult = await generateImage(imagePrompt);
          savedContent += `\n[IMAGE:${imgResult.mimeType}|${imgResult.b64_json}]`;
          res.write(`data: ${JSON.stringify({ imageData: { b64: imgResult.b64_json, mimeType: imgResult.mimeType } })}\n\n`);
        } catch (imgErr) {
          req.log.error({ imgErr }, "[Cortex] Image generation failed");
        }
      }

      await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });

      const isFirstMessage = history.length === 0;
      if (isFirstMessage) {
        let newTitle: string | null = null;
        try {
          const titleResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{
              role: "user",
              parts: [{ text: `What is the main topic or question in this message? Give a short title (3-5 words). Reply with ONLY the title, no punctuation at end.\n\nMessage: "${content.slice(0, 400)}"` }],
            }],
            config: { maxOutputTokens: 20 },
          });
          const candidate = titleResponse.text?.trim().replace(/["'.!?]$/g, "");
          if (candidate && candidate.length > 0 && candidate.length < 80) newTitle = candidate;
        } catch { /* fall through */ }

        if (!newTitle) newTitle = "New Chat";

        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

      if (userId) {
        extractAndSaveMemories(userId, content).catch(() => {});
      }
    }
  } catch (err) {
    req.log.error({ err }, "[Cortex] Gemini error");
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
