import { useState, useRef, useEffect, useCallback } from "react";
import {
  useGetOpenaiConversation,
  useCreateOpenaiConversation,
  useListOpenaiMessages,
  getListOpenaiConversationsQueryKey,
  getGetOpenaiConversationQueryKey,
  getListOpenaiMessagesQueryKey,
} from "@workspace/api-client-react";
import LanguageSelector from "./LanguageSelector";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Code2, Square, AlertTriangle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface ChatAreaProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
}

function looksLikeCode(text: string): boolean {
  const codePatterns = [
    /^\s*(function|def|class|import|from|const|let|var|if|for|while|return)\b/m,
    /[{};]\s*\n/,
    /^\s{2,}[\w(]/m,
    /\bprint\(|console\.log\(|System\.out|printf\(/,
    /=>\s*\{|=>\s*\w+/,
    /```[\s\S]*```/,
  ];
  const lines = text.split("\n");
  return lines.length > 3 && codePatterns.some((p) => p.test(text));
}

function checkSyntaxIssues(text: string): string[] {
  const issues: string[] = [];

  if (!text.trim()) {
    issues.push("Empty input");
    return issues;
  }

  // Only check bracket balance if it looks like code
  if (looksLikeCode(text)) {
    const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
    const stack: string[] = [];
    let inString = false;
    let stringChar = "";

    for (const ch of text) {
      if (inString) {
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if ("({[".includes(ch)) stack.push(ch);
      else if (")}]".includes(ch)) {
        if (stack[stack.length - 1] !== pairs[ch]) {
          issues.push("Mismatched or missing brackets");
          break;
        }
        stack.pop();
      }
    }
    if (stack.length > 0 && !issues.includes("Mismatched or missing brackets")) {
      issues.push("Unclosed brackets detected");
    }
  }

  return issues;
}

function buildSmartPrompt(userInput: string): { prompt: string; warning: string | null } {
  const input = userInput.trim();
  const isCode = looksLikeCode(input);
  const issues = checkSyntaxIssues(input);

  const hasFixKeyword = /\b(fix|debug|error|bug|broken|wrong|issue|problem|not working)\b/i.test(input);
  const isJustCode = isCode && input.split("\n").length > 4 && !input.toLowerCase().includes("fix") && !input.includes("?");

  let prompt = input;
  let warning: string | null = null;

  if (issues.length > 0 && isCode) {
    warning = `Heads up: ${issues.join(", ")} found in your code. Sending it anyway with a note for the AI.`;
    prompt = `${input}\n\n[POSSIBLE SYNTAX ISSUES DETECTED: ${issues.join(", ")}]`;
  }

  if (isJustCode && !hasFixKeyword) {
    prompt = `${prompt}\n\n[Please explain what this code does in beginner-friendly terms, then break down the key parts.]`;
  } else if (hasFixKeyword && isCode) {
    prompt = `${prompt}\n\n[Smart debug mode: Find the bug, explain why it's a problem in simple terms, then show the fixed code.]`;
  }

  return { prompt, warning };
}

export default function ChatArea({ conversationId, onConversationCreated }: ChatAreaProps) {
  const queryClient = useQueryClient();
  const [selectedLanguage, setSelectedLanguage] = useState("TypeScript");
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [displayedContent, setDisplayedContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const charQueueRef = useRef<string>("");
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamingContentRef = useRef<string>("");

  const { data: conversation } = useGetOpenaiConversation(conversationId!, {
    query: {
      enabled: !!conversationId,
      queryKey: getGetOpenaiConversationQueryKey(conversationId!),
    },
  });

  const { data: serverMessages = [] } = useListOpenaiMessages(conversationId!, {
    query: {
      enabled: !!conversationId,
      queryKey: getListOpenaiMessagesQueryKey(conversationId!),
    },
  });

  const createMutation = useCreateOpenaiConversation();

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [serverMessages, displayedContent, scrollToBottom]);

  // Typewriter effect: drain charQueue into displayedContent at ~120 chars/sec
  useEffect(() => {
    if (isStreaming) {
      displayTimerRef.current = setInterval(() => {
        if (charQueueRef.current.length > 0) {
          const batch = charQueueRef.current.slice(0, 6);
          charQueueRef.current = charQueueRef.current.slice(6);
          setDisplayedContent((prev) => prev + batch);
        }
      }, 25);
    } else {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
      charQueueRef.current = "";
    }
    return () => {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    };
  }, [isStreaming]);

  // Feed new streaming tokens into the char queue
  useEffect(() => {
    charQueueRef.current += streamingContent.slice(displayedContent.length + charQueueRef.current.length);
  }, [streamingContent, displayedContent]);

  // Apply pending title update to sidebar
  useEffect(() => {
    if (pendingTitle) {
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      if (conversationId) {
        queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(conversationId) });
      }
      setPendingTitle(null);
    }
  }, [pendingTitle, conversationId, queryClient]);

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    charQueueRef.current = "";
    setIsStreaming(false);
    setIsThinking(false);
    setStreamingContent("");
    setDisplayedContent("");
    queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(conversationId!) });
  };

  const handleSend = async () => {
    if (isStreaming) {
      handleCancel();
      return;
    }

    if (!input.trim()) return;

    const { prompt, warning: syntaxWarning } = buildSmartPrompt(input);
    setWarning(syntaxWarning);

    let targetId = conversationId;
    setInput("");

    if (!targetId) {
      const newConv = await createMutation.mutateAsync({
        data: { title: "New Chat", language: selectedLanguage },
      });
      targetId = newConv.id;
      onConversationCreated(targetId);
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
    }

    setIsThinking(true);
    setIsStreaming(false);
    setStreamingContent("");
    setDisplayedContent("");
    charQueueRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/openai/conversations/${targetId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompt }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("Network error");
      if (!response.body) throw new Error("No response body");

      setIsThinking(false);
      setIsStreaming(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(trimmed.slice(6));

            if (data.content) {
              streamingContentRef.current += data.content as string;
              setStreamingContent(streamingContentRef.current);
            }
            if (data.error) {
              setStreamingContent((prev) => prev || `Sorry, something went wrong: ${data.error}`);
              done = true;
            }
            if (data.titleUpdate) {
              setPendingTitle(data.titleUpdate as string);
            }
            if (data.done) {
              done = true;
            }
          } catch {
            // ignore parse errors for partial chunks
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setStreamingContent("Connection error. Please try again.");
      }
      setIsThinking(false);
    } finally {
      abortRef.current = null;
      // Flush any remaining queued characters immediately
      const finalContent = streamingContentRef.current;
      streamingContentRef.current = "";
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
      charQueueRef.current = "";
      setDisplayedContent(finalContent);
      setIsStreaming(false);
      setIsThinking(false);
      setStreamingContent("");
      queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(targetId!) });
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      // Clear displayed content after the server messages render
      setTimeout(() => setDisplayedContent(""), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const inputBar = (placeholder: string) => (
    <div className="p-4 border-t bg-background shadow-sm shrink-0">
      {warning && (
        <div className="max-w-4xl mx-auto mb-2 flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      <div className="max-w-4xl mx-auto flex gap-3">
        <Textarea
          ref={inputRef}
          placeholder={placeholder}
          className="resize-none min-h-[60px] max-h-[200px] shadow-sm border-input rounded-xl"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (warning) setWarning(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={isThinking}
        />
        <Button
          className={`h-[60px] w-[60px] rounded-xl shrink-0 transition-colors ${
            isStreaming ? "bg-red-500 hover:bg-red-600" : "bg-primary hover:bg-primary/90"
          }`}
          onClick={handleSend}
          disabled={isThinking || (!input.trim() && !isStreaming)}
        >
          {isThinking ? (
            <div className="flex gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-bounce [animation-delay:300ms]" />
            </div>
          ) : isStreaming ? (
            <Square className="w-5 h-5 fill-white" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground text-center mt-2">
        {isStreaming ? "Click the stop button to cancel" : "Enter to send · Shift+Enter for new line"}
      </p>
    </div>
  );

  if (!conversationId) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto">
              <Code2 className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold text-foreground">Welcome to CodeGen</h1>
            <p className="text-muted-foreground text-lg">
              Your intelligent programming partner. Select a language to get started.
            </p>
            <div className="pt-4 max-w-xs mx-auto">
              <LanguageSelector value={selectedLanguage} onChange={setSelectedLanguage} />
            </div>
          </div>
        </div>
        {inputBar("Ask CodeGen to write some code...")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="h-14 border-b flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">{conversation?.title ?? "Loading..."}</span>
          <span className="text-xs text-muted-foreground">{conversation?.language ?? selectedLanguage}</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 scroll-smooth"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="max-w-4xl mx-auto space-y-6 pb-4">
          {serverMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              role={msg.role as "user" | "assistant"}
              content={msg.content}
            />
          ))}
          {(isThinking || isStreaming) && (
            <MessageBubble
              role="assistant"
              content={displayedContent}
              isStreaming={isStreaming}
              isThinking={isThinking}
            />
          )}
        </div>
      </div>

      {inputBar("Ask a follow-up question or paste some code...")}
    </div>
  );
}
