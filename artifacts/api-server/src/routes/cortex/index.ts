import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

router.post("/chat", async (req, res) => {
  const { messages: chatHistory = [], planMode = false } = req.body;

  let systemPrompt = `You are Cortex, an advanced AI assistant created by CodeGen. You are knowledgeable, thoughtful, and helpful across all topics — from science, math, writing, and history to creative projects, coding help, life advice, and everything in between.

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

  if (planMode) {
    systemPrompt += `

PLAN MODE IS ACTIVE: The user wants to think through and plan their approach, NOT get final answers or code yet. Your job is to:
- Ask clarifying questions to understand what they want to achieve
- Help them break down the problem into clear steps or phases
- Offer multiple possible approaches with trade-offs
- Create structured outlines, roadmaps, or frameworks
- Use pseudocode or high-level descriptions only — no actual implementation code
- Think out loud with the user and help them make decisions
- End your responses with a question or suggestion that moves the planning forward`;
  }

  const formattedMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...chatHistory.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      messages: formattedMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
