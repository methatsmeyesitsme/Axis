import { useState, useRef, useEffect, useCallback } from "react";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Sparkles, Square, LogIn, Plus, Paperclip, X, ChevronDown } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface CortexAreaProps {
  onOpenAuth: () => void;
}

interface Attachment {
  name: string;
  content: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function CortexArea({ onOpenAuth }: CortexAreaProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [displayedContent, setDisplayedContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charQueueRef = useRef<string>("");
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamDoneRef = useRef(false);
  const pendingMessageRef = useRef<string>("");

  const isNearBottom = useCallback(() => {
    if (!scrollRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    return scrollHeight - scrollTop - clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setShowScrollButton(false);
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollButton(scrollHeight - scrollTop - clientHeight > 120);
  }, []);

  useEffect(() => {
    if (isNearBottom()) scrollToBottom();
  }, [messages, displayedContent, scrollToBottom, isNearBottom]);

  // Typewriter interval — drains queue, finalizes when done
  useEffect(() => {
    if (!isStreaming) return;

    displayTimerRef.current = setInterval(() => {
      if (charQueueRef.current.length > 0) {
        const batch = charQueueRef.current.slice(0, 5);
        charQueueRef.current = charQueueRef.current.slice(5);
        setDisplayedContent((prev) => prev + batch);
      } else if (streamDoneRef.current) {
        clearInterval(displayTimerRef.current!);
        displayTimerRef.current = null;
        streamDoneRef.current = false;
        const finalMsg = pendingMessageRef.current;
        pendingMessageRef.current = "";
        setIsStreaming(false);
        if (finalMsg) {
          setMessages((prev) => [...prev, { role: "assistant", content: finalMsg }]);
          setTimeout(() => setDisplayedContent(""), 600);
        } else {
          setDisplayedContent("");
        }
      }
    }, 30);

    return () => {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    };
  }, [isStreaming]);

  const handleCancel = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    const partial = pendingMessageRef.current;
    pendingMessageRef.current = "";
    charQueueRef.current = "";
    streamDoneRef.current = false;
    setIsStreaming(false);
    setIsThinking(false);
    setDisplayedContent("");
    if (partial) setMessages((prev) => [...prev, { role: "assistant", content: partial }]);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        setAttachments((prev) => [...prev, { name: file.name, content: `[Image attached: ${file.name}]` }]);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target?.result as string;
          setAttachments((prev) => [...prev, { name: file.name, content: `File: ${file.name}\n\`\`\`\n${text}\n\`\`\`` }]);
        };
        reader.readAsText(file);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if (isStreaming) { handleCancel(); return; }
    if (!input.trim() && attachments.length === 0) return;

    const attachmentText = attachments.map((a) => a.content).join("\n\n");
    const fullInput = attachmentText ? `${attachmentText}\n\n${input}` : input;
    const userMsg: ChatMessage = { role: "user", content: fullInput };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setAttachments([]);

    charQueueRef.current = "";
    pendingMessageRef.current = "";
    streamDoneRef.current = false;
    setDisplayedContent("");
    setIsThinking(true);
    setIsStreaming(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/cortex/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
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
              pendingMessageRef.current += data.content as string;
              charQueueRef.current += data.content as string;
            }
            if (data.error) {
              const errMsg = `Sorry, something went wrong: ${data.error}`;
              charQueueRef.current += errMsg;
              pendingMessageRef.current += errMsg;
              done = true;
            }
            if (data.done) done = true;
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        const errMsg = "Connection error. Please try again.";
        charQueueRef.current += errMsg;
        pendingMessageRef.current += errMsg;
      }
      setIsThinking(false);
    } finally {
      abortRef.current = null;
      setIsThinking(false);
      streamDoneRef.current = true;
      if (charQueueRef.current.length === 0) {
        streamDoneRef.current = false;
        setIsStreaming(false);
        setDisplayedContent("");
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const inputBar = (placeholder: string) => (
    <div className="p-4 border-t bg-background shadow-sm shrink-0">
      {!user && (
        <div className="max-w-4xl mx-auto mb-2">
          <button onClick={onOpenAuth} className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors py-1.5">
            <LogIn className="w-3.5 h-3.5" />
            Log in to save your chats
          </button>
        </div>
      )}
      <div className="max-w-4xl mx-auto">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-muted border border-border rounded-lg px-2.5 py-1 text-xs text-foreground">
                <Paperclip className="w-3 h-3 text-muted-foreground" />
                <span className="max-w-[120px] truncate">{att.name}</span>
                <button onClick={() => removeAttachment(i)} className="text-muted-foreground hover:text-foreground ml-0.5">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="border border-input rounded-2xl bg-card shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all">
          <Textarea
            ref={inputRef}
            placeholder={placeholder}
            className="min-h-[110px] max-h-[320px] border-0 shadow-none rounded-none focus-visible:ring-0 resize-none px-4 pt-3 pb-2 bg-transparent text-[14.5px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isThinking}
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,text/*,.js,.ts,.tsx,.jsx,.py,.java,.cpp,.cs,.go,.html,.css,.json,.md,.txt" onChange={handleFileUpload} />
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted" onClick={() => fileInputRef.current?.click()} title="Attach file" type="button">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2.5">
              <Button
                className={`h-8 w-8 rounded-lg shrink-0 transition-colors ${isStreaming ? "bg-red-500 hover:bg-red-600" : "bg-primary hover:bg-primary/90"}`}
                onClick={handleSend}
                disabled={isThinking || (!input.trim() && attachments.length === 0 && !isStreaming)}
                size="icon"
              >
                {isThinking ? (
                  <div className="flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:300ms]" />
                  </div>
                ) : isStreaming ? (
                  <Square className="w-4 h-4 fill-white" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-2">
          {isStreaming ? "Click stop to cancel" : "Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );

  if (messages.length === 0 && !isStreaming && !isThinking) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <div className="text-center px-8 pt-10 pb-0">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Cortex</h1>
          <p className="text-muted-foreground text-base mt-2">Your intelligent AI assistant — ask me anything.</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-2xl font-semibold text-foreground">
            {user ? `Hello, ${user.username}! How can I help?` : "Hello! How can I help you today?"}
          </p>
        </div>
        {inputBar("Ask Cortex anything...")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="h-14 border-b flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Cortex</span>
          <span className="text-xs text-muted-foreground">General AI</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-7" onClick={() => { setMessages([]); setDisplayedContent(""); charQueueRef.current = ""; }}>
            New chat
          </Button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto p-6" style={{ scrollBehavior: "smooth" }}>
          <div className="max-w-4xl mx-auto space-y-6 pb-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} role={msg.role} content={msg.content} />
            ))}
            {(isThinking || isStreaming) && (
              <MessageBubble role="assistant" content={displayedContent} isStreaming={isStreaming} isThinking={isThinking} />
            )}
          </div>
        </div>
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-all animate-in fade-in slide-in-from-bottom-2 duration-200"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            Scroll to latest
          </button>
        )}
      </div>

      {inputBar("Ask Cortex anything...")}
    </div>
  );
}
