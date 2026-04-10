import { useState } from "react";
import { Check, Copy, Download, User, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isThinking?: boolean;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const extMap: Record<string, string> = {
      javascript: "js", typescript: "ts", python: "py", java: "java",
      cpp: "cpp", csharp: "cs", go: "go", rust: "rs", php: "php",
      ruby: "rb", swift: "swift", kotlin: "kt", dart: "dart", lua: "lua",
      luau: "luau", sql: "sql", bash: "sh", shell: "sh", r: "r", html: "html",
      css: "css",
    };
    const ext = extMap[language?.toLowerCase()] ?? "txt";
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codegen-snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const displayLang = language || "code";

  return (
    <div className="my-4 rounded-xl border border-gray-700 shadow-md">
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 bg-[#1a1f2e] border-b border-gray-700 rounded-t-xl">
        <span className="text-xs font-mono text-gray-400">{displayLang}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10"
            onClick={handleDownload}
            title="Download"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10"
            onClick={handleCopy}
            title="Copy"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
      <div className="rounded-b-xl overflow-hidden">
        <SyntaxHighlighter
          language={displayLang}
          style={atomOneDark}
          customStyle={{
            margin: 0,
            padding: "1rem",
            fontSize: "0.8125rem",
            lineHeight: "1.6",
            background: "#1E293B",
          }}
          showLineNumbers
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-sm text-muted-foreground italic">Thinking</span>
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function renderContent(text: string) {
  if (!text) return null;

  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);

  return parts.map((part, index) => {
    if (part.startsWith("```")) {
      const closed = part.endsWith("```") && part.length > 3;
      const inner = closed ? part.slice(3, -3) : part.slice(3);
      const newlineIdx = inner.indexOf("\n");
      const lang = newlineIdx > -1 ? inner.slice(0, newlineIdx).trim() : "";
      const code = newlineIdx > -1 ? inner.slice(newlineIdx + 1) : inner;
      return <CodeBlock key={index} language={lang} code={code.trimEnd()} />;
    }

    if (!part.trim()) return null;

    const lines = part.split("\n");
    return (
      <div key={index} className="space-y-1.5">
        {lines.map((line, i) => {
          if (!line.trim() && i > 0) return <div key={i} className="h-1" />;

          const segments = line.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
          return (
            <p key={i} className="leading-relaxed">
              {segments.map((seg, j) => {
                if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 2)
                  return (
                    <code key={j} className="bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono text-[0.8em]">
                      {seg.slice(1, -1)}
                    </code>
                  );
                if (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4)
                  return <strong key={j} className="font-semibold text-foreground">{seg.slice(2, -2)}</strong>;
                if (seg.startsWith("*") && seg.endsWith("*") && seg.length > 2)
                  return <em key={j}>{seg.slice(1, -1)}</em>;
                return <span key={j}>{seg}</span>;
              })}
            </p>
          );
        })}
      </div>
    );
  });
}

export default function MessageBubble({ role, content, isStreaming, isThinking }: MessageBubbleProps) {
  const isUser = role === "user";

  return (
    <div className={`flex gap-3 w-full ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}

      <div
        className={`max-w-[85%] rounded-2xl px-5 py-4 ${
          isUser
            ? "bg-primary text-primary-foreground rounded-tr-sm shadow-sm"
            : "bg-card border border-border text-card-foreground rounded-tl-sm shadow-sm"
        }`}
      >
        <div className="text-[14.5px]">
          {isThinking && !content ? (
            <ThinkingIndicator />
          ) : (
            <>
              {renderContent(content)}
              {isStreaming && (
                <span className="inline-block w-0.5 h-4 ml-0.5 bg-primary animate-pulse align-middle rounded-full" />
              )}
            </>
          )}
        </div>
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
          <User className="w-4 h-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
