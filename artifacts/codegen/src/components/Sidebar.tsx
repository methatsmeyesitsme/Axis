import { useState } from "react";
import { 
  useListOpenaiConversations, 
  useDeleteOpenaiConversation 
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, Trash2, Code2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";

interface SidebarProps {
  activeConversationId: number | null;
  onSelectConversation: (id: number | null) => void;
}

export default function Sidebar({ activeConversationId, onSelectConversation }: SidebarProps) {
  const queryClient = useQueryClient();
  const { data: conversations = [], isLoading } = useListOpenaiConversations();
  const deleteMutation = useDeleteOpenaiConversation();

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/openai/conversations"] });
        if (activeConversationId === id) {
          onSelectConversation(null);
        }
      }
    });
  };

  return (
    <div className="w-72 bg-sidebar border-r flex flex-col h-full flex-shrink-0">
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary font-semibold text-lg">
          <Code2 className="w-6 h-6" />
          CodeGen
        </div>
      </div>
      
      <div className="p-4">
        <Button 
          className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-white font-medium shadow-sm"
          onClick={() => onSelectConversation(null)}
        >
          <Plus className="w-4 h-4" />
          New Chat
        </Button>
      </div>

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
                  <span className="text-xs text-muted-foreground ml-6 truncate">
                    {conv.language}
                  </span>
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
    </div>
  );
}
