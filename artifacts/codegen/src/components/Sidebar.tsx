import { 
  useListOpenaiConversations, 
  useDeleteOpenaiConversation 
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, Trash2, Code2, Settings, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";

type Tab = "codex" | "cortex";

interface SidebarProps {
  activeConversationId: number | null;
  onSelectConversation: (id: number | null) => void;
  onOpenSettings: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export default function Sidebar({ activeConversationId, onSelectConversation, onOpenSettings, activeTab, onTabChange }: SidebarProps) {
  const queryClient = useQueryClient();
  const { data: conversations = [], isLoading } = useListOpenaiConversations();
  const deleteMutation = useDeleteOpenaiConversation();

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations"] });
        if (activeConversationId === id) onSelectConversation(null);
      }
    });
  };

  return (
    <div className="w-72 bg-sidebar border-r flex flex-col h-full flex-shrink-0">
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary font-semibold text-lg">
          <Code2 className="w-6 h-6" />
          Axis
        </div>
      </div>

      <div className="px-3 pt-3 pb-1">
        <div className="flex gap-1 bg-muted p-1 rounded-xl">
          <button
            onClick={() => onTabChange("codex")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === "codex"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            Codex
          </button>
          <button
            onClick={() => onTabChange("cortex")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === "cortex"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Cortex
          </button>
        </div>
      </div>

      {activeTab === "codex" && (
        <div className="p-3 pt-2">
          <Button
            className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-white font-medium shadow-sm"
            onClick={() => onSelectConversation(null)}
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>
      )}

      {activeTab === "codex" ? (
        <ScrollArea className="flex-1 px-3">
          <div className="space-y-1 pb-4">
            {isLoading ? (
              <div className="px-2 py-4 text-sm text-muted-foreground text-center">Loading...</div>
            ) : conversations.length === 0 ? (
              <div className="px-2 py-8 text-sm text-muted-foreground text-center">No past chats</div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => onSelectConversation(conv.id)}
                  className={`group flex items-center justify-between px-3 py-3 rounded-lg cursor-pointer transition-colors ${
                    activeConversationId === conv.id
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted text-foreground"
                  }`}
                >
                  <div className="flex flex-col overflow-hidden gap-1">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 shrink-0 opacity-70" />
                      <span className="text-sm font-medium truncate">{conv.title || "New Chat"}</span>
                    </div>
                    <span className="text-xs text-muted-foreground ml-6 truncate">{conv.language}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive shrink-0 transition-opacity"
                    onClick={(e) => handleDelete(conv.id, e)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center gap-2">
          <Sparkles className="w-8 h-8 text-primary/40" />
          <p className="text-sm text-muted-foreground">Cortex keeps chats in memory during your session</p>
        </div>
      )}

      <div className="shrink-0">
        <div className="mx-3 border-t" />
        <div className="p-3">
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Settings className="w-4 h-4 shrink-0" />
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
