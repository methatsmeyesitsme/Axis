import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    res.json([]);
    return;
  }
  const result = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.createdAt));
  const cortexConvs = result.filter((c) => c.source === "cortex");
  res.json(
    cortexConvs.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
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
  res.status(201).json({
    id: created.id,
    title: created.title,
    createdAt: created.createdAt,
  });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    messages: msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json(
    msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }))
  );
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content } = req.body as { content: string };

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv || conv.source !== "cortex") {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content,
  });

  const systemPrompt = `You are Cortex, an advanced AI assistant created by CodeGen. You are knowledgeable, thoughtful, and helpful across all topics — from science, math, writing, and history to creative projects, coding help, life advice, and everything in between.

CORE BEHAVIOR:
1. Give clear, accurate, well-structured answers. Use examples, analogies, and step-by-step reasoning when helpful.
2. Adapt your tone to the user — casual and friendly for general questions, precise and technical when the topic demands it.
3. For complex questions, break your answer into clear sections or steps.
4. When you're uncertain, say so clearly and explain what you do know.
5. Be honest, balanced, and thoughtful. Never be preachy or condescending.
6. Format responses with markdown when it improves readability: use **bold** for key terms, bullet lists for enumerations, and headers for multi-section answers.
7. For math and logic problems, show your work step-by-step.
8. Be concise when the answer is simple; go deeper when the question requires it.
9. You have a broad, up-to-date knowledge base. Draw on it confidently.
10. If the user shares code or asks coding questions, help them clearly — but remember you are a general assistant, not specialized like Axis (the coding tab).`;

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
      config: {
        maxOutputTokens: 8192,
        systemInstruction: systemPrompt,
      },
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
      await db.insert(messages).values({
        conversationId: id,
        role: "assistant",
        content: fullResponse,
      });

      const isFirstMessage = history.length === 0;
      if (isFirstMessage) {
        let newTitle: string | null = null;
        try {
          const titleResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Create a short title (3-5 words max) summarizing this question or topic: "${content.slice(0, 300)}". Reply with ONLY the title, no quotes, no punctuation at end, no markdown.`,
                  },
                ],
              },
            ],
            config: { maxOutputTokens: 15 },
          });
          const candidate = titleResponse.text?.trim();
          if (candidate && candidate.length > 0 && candidate.length < 80) {
            newTitle = candidate;
          }
        } catch {
          // fall through to text extraction
        }

        if (!newTitle) {
          const cleaned = content.replace(/[`*_#]/g, "").trim();
          const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
          newTitle = words.length > 0 ? words : "Untitled Chat";
        }

        if (newTitle) {
          await db
            .update(conversations)
            .set({ title: newTitle })
            .where(eq(conversations.id, id));
          res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
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
