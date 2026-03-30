import { useState } from "react";
import { Check, Copy, User, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-4 rounded-xl overflow-hidden bg-[#1E293B] border border-gray-800 shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900/80 border-b border-gray-800">
        <span className="text-xs font-mono text-gray-400 lowercase">{language || 'code'}</span>
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-6 w-6 text-gray-400 hover:text-white hover:bg-gray-800"
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </Button>
      </div>
      <div className="p-4 overflow-x-auto text-sm font-mono text-gray-100 leading-relaxed">
        <pre><code>{code}</code></pre>
      </div>
    </div>
  );
}

function renderContent(text: string) {
  if (!text) return null;
  
  // Simple regex to extract code blocks: matches ```lang\ncode```
  const parts = text.split(/(```[\s\S]*?```)/g);
  
  return parts.map((part, index) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const match = part.match(/```(\w*)\n([\s\S]*?)```/);
      if (match) {
        const [, lang, code] = match;
        return <CodeBlock key={index} language={lang} code={code.trim()} />;
      }
      // fallback if regex doesn't capture exactly
      const code = part.slice(3, -3).trim();
      return <CodeBlock key={index} language="" code={code} />;
    }
    
    // Parse inline bold, italic, code for standard text
    if (!part.trim()) return null;
    
    const lines = part.split('\n');
    return (
      <div key={index} className="space-y-2">
        {lines.map((line, i) => (
          <p key={i} className="leading-relaxed">
            {line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((segment, j) => {
              if (segment.startsWith('`') && segment.endsWith('`')) {
                return <code key={j} className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-md font-mono text-sm">{segment.slice(1, -1)}</code>;
              }
              if (segment.startsWith('**') && segment.endsWith('**')) {
                return <strong key={j} className="font-semibold text-foreground">{segment.slice(2, -2)}</strong>;
              }
              return <span key={j}>{segment}</span>;
            })}
          </p>
        ))}
      </div>
    );
  });
}

export default function MessageBubble({ role, content, isStreaming }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex gap-4 w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
          <Bot className="w-5 h-5 text-primary" />
        </div>
      )}
      
      <div className={`max-w-[85%] rounded-2xl px-5 py-4 ${
        isUser 
          ? 'bg-primary text-primary-foreground rounded-tr-sm shadow-sm' 
          : 'bg-card border border-border text-card-foreground rounded-tl-sm shadow-sm'
      }`}>
        <div className="text-[15px]">
          {renderContent(content)}
          {isStreaming && (
            <span className="inline-block w-2 h-4 ml-1 bg-primary animate-pulse align-middle" />
          )}
        </div>
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
          <User className="w-5 h-5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
