import { useState } from "react";
import {
  useListOpenaiConversations,
  useDeleteOpenaiConversation,
  useRenameOpenaiConversation,
  useListCortexConversations,
  useDeleteCortexConversation,
  useRenameCortexConversation,
  getListOpenaiConversationsQueryKey,
  getListCortexConversationsQueryKey,
  getGetOpenaiConversationQueryKey,
  getGetCortexConversationQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Plus, MessageSquare, Code2, Settings, Sparkles, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";

type Tab = "codex" | "cortex";

interface SidebarProps {
  activeConversationId: number | null;
  onSelectConversation: (id: number | null) => void;
  activeCortexConversationId: number | null;
  onSelectCortexConversation: (id: number | null) => void;
  onOpenSettings: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

interface ConvItem {
  id: number;
  title: string;
  subtitle?: string;
}

function ConversationItem({
  conv,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  conv: ConvItem;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center justify-between px-3 py-3 rounded-lg cursor-pointer transition-colors ${
        isActive ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
      }`}
    >
      <div className="flex flex-col overflow-hidden gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 shrink-0 opacity-70" />
          <span className="text-sm font-medium truncate">{conv.title || "New Chat"}</span>
        </div>
        {conv.subtitle && (
          <span className="text-xs text-muted-foreground ml-6 truncate">{conv.subtitle}</span>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="h-7 w-7 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/15 transition-opacity shrink-0 ml-1"
          >
            <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onRename(); }}
            className="gap-2 cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="gap-2 cursor-pointer text-destructive focus:text-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function Sidebar({
  activeConversationId,
  onSelectConversation,
  activeCortexConversationId,
  onSelectCortexConversation,
  onOpenSettings,
  activeTab,
  onTabChange,
}: SidebarProps) {
  const queryClient = useQueryClient();

  const { data: conversations = [], isLoading: axisLoading } = useListOpenaiConversations();
  const { data: cortexConversations = [], isLoading: cortexLoading } = useListCortexConversations();

  const deleteAxisMutation = useDeleteOpenaiConversation();
  const deleteCortexMutation = useDeleteCortexConversation();
  const renameAxisMutation = useRenameOpenaiConversation();
  const renameCortexMutation = useRenameCortexConversation();

  // Rename state
  const [renameDialog, setRenameDialog] = useState<{ id: number; title: string; kind: "axis" | "cortex" } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirmation state
  const [deleteDialog, setDeleteDialog] = useState<{ id: number; kind: "axis" | "cortex" } | null>(null);

  const openRename = (id: number, title: string, kind: "axis" | "cortex") => {
    setRenameValue(title);
    setRenameDialog({ id, title, kind });
  };

  const confirmRename = () => {
    if (!renameDialog || !renameValue.trim()) return;
    const { id, kind } = renameDialog;
    if (kind === "axis") {
      renameAxisMutation.mutate({ id, data: { title: renameValue.trim() } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(id) });
        },
      });
    } else {
      renameCortexMutation.mutate({ id, data: { title: renameValue.trim() } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCortexConversationQueryKey(id) });
        },
      });
    }
    setRenameDialog(null);
  };

  const openDelete = (id: number, kind: "axis" | "cortex") => {
    setDeleteDialog({ id, kind });
  };

  const confirmDelete = () => {
    if (!deleteDialog) return;
    const { id, kind } = deleteDialog;
    if (kind === "axis") {
      deleteAxisMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          if (activeConversationId === id) onSelectConversation(null);
        },
      });
    } else {
      deleteCortexMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
          if (activeCortexConversationId === id) onSelectCortexConversation(null);
        },
      });
    }
    setDeleteDialog(null);
  };

  return (
    <>
      <div className="w-72 bg-sidebar border-r flex flex-col h-full flex-shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-primary font-semibold text-lg">
            {activeTab === "codex" ? "Axis" : "Cortex"}
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

        <div className="p-3 pt-2">
          <Button
            className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-white font-medium shadow-sm"
            onClick={() =>
              activeTab === "codex" ? onSelectConversation(null) : onSelectCortexConversation(null)
            }
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>

        {activeTab === "codex" ? (
          <ScrollArea className="flex-1 px-3">
            <div className="space-y-1 pb-4">
              {axisLoading ? (
                <div className="px-2 py-4 text-sm text-muted-foreground text-center">Loading...</div>
              ) : conversations.length === 0 ? (
                <div className="px-2 py-8 text-sm text-muted-foreground text-center">No past chats</div>
              ) : (
                conversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conv={{ id: conv.id, title: conv.title, subtitle: conv.language }}
                    isActive={activeConversationId === conv.id}
                    onSelect={() => onSelectConversation(conv.id)}
                    onRename={() => openRename(conv.id, conv.title, "axis")}
                    onDelete={() => openDelete(conv.id, "axis")}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea className="flex-1 px-3">
            <div className="space-y-1 pb-4">
              {cortexLoading ? (
                <div className="px-2 py-4 text-sm text-muted-foreground text-center">Loading...</div>
              ) : cortexConversations.length === 0 ? (
                <div className="px-2 py-8 text-sm text-muted-foreground text-center">No past chats</div>
              ) : (
                cortexConversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conv={{ id: conv.id, title: conv.title }}
                    isActive={activeCortexConversationId === conv.id}
                    onSelect={() => onSelectCortexConversation(conv.id)}
                    onRename={() => openRename(conv.id, conv.title, "cortex")}
                    onDelete={() => openDelete(conv.id, "cortex")}
                  />
                ))
              )}
            </div>
          </ScrollArea>
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

      {/* Rename Dialog */}
      <Dialog open={!!renameDialog} onOpenChange={(open) => { if (!open) setRenameDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmRename(); }}
            placeholder="Enter a new name"
            autoFocus
            className="mt-1"
          />
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setRenameDialog(null)}>Cancel</Button>
            <Button onClick={confirmRename} disabled={!renameValue.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => { if (!open) setDeleteDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the conversation and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
