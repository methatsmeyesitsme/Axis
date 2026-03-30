import { useState, useRef, useEffect } from "react";
import { 
  useGetOpenaiConversation, 
  useCreateOpenaiConversation,
  useListOpenaiMessages
} from "@workspace/api-client-react";
import type { OpenaiMessage } from "@workspace/api-client-react/src/generated/api.schemas";
import LanguageSelector from "./LanguageSelector";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Code2, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface ChatAreaProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
}

export default function ChatArea({ conversationId, onConversationCreated }: ChatAreaProps) {
  const queryClient = useQueryClient();
  const [selectedLanguage, setSelectedLanguage] = useState("TypeScript");
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: conversation, isLoading: isLoadingConv } = useGetOpenaiConversation(
    conversationId!, 
    { query: { enabled: !!conversationId, queryKey: ["/api/openai/conversations", conversationId] } }
  );

  const { data: serverMessages = [] } = useListOpenaiMessages(
    conversationId!,
    { query: { enabled: !!conversationId, queryKey: ["/api/openai/conversations", conversationId, "messages"] } }
  );

  const createMutation = useCreateOpenaiConversation();

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [serverMessages, streamingContent]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    
    let targetId = conversationId;
    const userMessageContent = input.trim();
    setInput("");

    if (!targetId) {
      const newConv = await createMutation.mutateAsync({
        data: { title: "New Chat", language: selectedLanguage }
      });
      targetId = newConv.id;
      onConversationCreated(targetId);
      queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations"] });
    }

    setIsStreaming(true);
    setStreamingContent("");

    // Optimistically add user message if we want, but server might take a moment.
    // We will just let the stream start.
    
    try {
      const response = await fetch(`/api/openai/conversations/${targetId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userMessageContent }),
      });

      if (!response.ok) throw new Error("Network response was not ok");
      if (!response.body) throw new Error("No body in response");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n").filter(l => l.trim().startsWith("data: "));
          
          for (const line of lines) {
            try {
              const data = JSON.parse(line.replace(/^data: /, ""));
              
              if (data.content) {
                setStreamingContent(prev => prev + data.content);
              }
              if (data.titleUpdate) {
                queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations"] });
                queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations", targetId] });
              }
              if (data.done) {
                done = true;
              }
            } catch (e) {
              console.error("Error parsing stream chunk", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Stream failed:", error);
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations", targetId, "messages"] });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!conversationId && !isLoadingConv) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background relative">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Code2 className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold text-foreground">Welcome to CodeGen</h1>
            <p className="text-muted-foreground text-lg">
              Your intelligent programming partner. Select a language to get started.
            </p>
            <div className="pt-8 max-w-xs mx-auto">
              <LanguageSelector 
                value={selectedLanguage} 
                onChange={setSelectedLanguage} 
              />
            </div>
          </div>
        </div>
        <div className="p-4 border-t bg-background">
          <div className="max-w-4xl mx-auto flex gap-4">
            <Textarea
              placeholder="Ask CodeGen to write some code..."
              className="resize-none min-h-[60px] max-h-[200px] shadow-sm border-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <Button 
              className="h-[60px] w-[60px] rounded-xl shrink-0" 
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
            >
              <Send className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative">
      <div className="h-14 border-b flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">{conversation?.title || "Loading..."}</span>
          <span className="text-xs text-muted-foreground">{conversation?.language || selectedLanguage}</span>
        </div>
      </div>

      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 scroll-smooth bg-gray-50/30"
      >
        <div className="max-w-4xl mx-auto space-y-6 pb-6">
          {serverMessages.map((msg) => (
            <MessageBubble key={msg.id} role={msg.role as 'user' | 'assistant'} content={msg.content} />
          ))}
          {isStreaming && (
            <MessageBubble role="assistant" content={streamingContent} isStreaming />
          )}
        </div>
      </div>

      <div className="p-4 border-t bg-background shadow-sm">
        <div className="max-w-4xl mx-auto flex gap-4">
          <Textarea
            placeholder="Ask a follow-up question..."
            className="resize-none min-h-[60px] max-h-[200px] shadow-sm border-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Button 
            className="h-[60px] w-[60px] rounded-xl shrink-0 bg-primary hover:bg-primary/90" 
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
          >
            {isStreaming ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
