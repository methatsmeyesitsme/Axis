import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useListOpenaiConversations,
  useDeleteOpenaiConversation,
  useRenameOpenaiConversation,
  useListCortexConversations,
  useDeleteCortexConversation,
  useRenameCortexConversation,
  useListForgeConversations,
  useCreateForgeConversation,
  useDeleteForgeConversation,
  useRenameForgeConversation,
  getListOpenaiConversationsQueryKey,
  getListCortexConversationsQueryKey,
  getListForgeConversationsQueryKey,
  getGetOpenaiConversationQueryKey,
  getGetCortexConversationQueryKey,
  getGetForgeConversationQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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
import { Plus, MessageSquare, Code2, Settings, Sparkles, MoreVertical, Pencil, Trash2, Hammer } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

type Tab = "codex" | "cortex" | "forge";
type ConvKind = "axis" | "cortex" | "forge";

interface SidebarProps {
  activeConversationId: number | null;
  onSelectConversation: (id: number | null) => void;
  activeCortexConversationId: number | null;
  onSelectCortexConversation: (id: number | null) => void;
  activeForgeConversationId: number | null;
  onSelectForgeConversation: (id: number | null) => void;
  onOpenSettings: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

interface ConvItem {
  id: number;
  title: string;
  subtitle?: string;
}

function AppTile({
  app,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  app: ConvItem;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.right - 144 });
    setMenuOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClose(e: MouseEvent) {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClose);
    return () => document.removeEventListener("mousedown", handleClose);
  }, [menuOpen]);

  return (
    <div
      onClick={onSelect}
      className={`relative aspect-square rounded-2xl cursor-pointer transition-colors flex flex-col items-center justify-center gap-1.5 p-2 ${
        isActive ? "bg-primary/10 ring-2 ring-primary/40" : "bg-muted hover:bg-muted/70"
      }`}
    >
      <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center">
        <Hammer className="w-4 h-4 text-primary" />
      </div>
      <span className="text-xs font-medium text-foreground text-center leading-tight line-clamp-2 px-1">
        {app.title || "New App"}
      </span>

      <button
        ref={btnRef}
        onClick={openMenu}
        style={{
          position: "absolute", right: 4, top: 4, display: "flex", alignItems: "center",
          justifyContent: "center", width: 20, height: 20, borderRadius: 4, border: "none",
          background: menuOpen ? "rgba(0,0,0,0.08)" : "transparent", cursor: "pointer", padding: 0,
        }}
        title="More options"
      >
        <MoreVertical style={{ width: 12, height: 12, color: "#6b7280" }} />
      </button>

      {menuOpen && createPortal(
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: menuPos.top, left: menuPos.left, zIndex: 99999,
            width: 144, borderRadius: 8, border: "1px solid #e5e7eb", background: "#ffffff",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", padding: "4px 0",
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRename(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", fontSize: 14, background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "#111827" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f3f4f6"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Pencil style={{ width: 13, height: 13 }} />
            Rename
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", fontSize: 14, background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "#ef4444" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fef2f2"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Trash2 style={{ width: 13, height: 13 }} />
            Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 4, left: rect.right - 144 });
    }
    setMenuOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClose(e: MouseEvent) {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClose);
    return () => document.removeEventListener("mousedown", handleClose);
  }, [menuOpen]);

  return (
    <div
      onClick={onSelect}
      style={{ position: "relative" }}
      className={`px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        isActive ? "bg-primary/10 text-primary" : "hover:bg-muted text-foreground"
      }`}
    >
      <div style={{ paddingRight: 28 }}>
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="text-sm font-medium truncate block">{conv.title || "New Chat"}</span>
        </div>
        {conv.subtitle && (
          <span className="text-xs text-muted-foreground ml-5 block truncate">{conv.subtitle}</span>
        )}
      </div>

      <button
        ref={btnRef}
        onClick={openMenu}
        style={{
          position: "absolute",
          right: 6,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 4,
          border: "none",
          background: menuOpen ? "rgba(0,0,0,0.08)" : "transparent",
          cursor: "pointer",
          padding: 0,
        }}
        title="More options"
      >
        <MoreVertical style={{ width: 14, height: 14, color: "#6b7280" }} />
      </button>

      {menuOpen && createPortal(
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 99999,
            width: 144,
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            background: "#ffffff",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            padding: "4px 0",
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRename(); }}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", fontSize: 14, background: "transparent",
              border: "none", cursor: "pointer", textAlign: "left", color: "#111827",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f3f4f6"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Pencil style={{ width: 13, height: 13 }} />
            Rename
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(); }}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: 8,
              padding: "8px 12px", fontSize: 14, background: "transparent",
              border: "none", cursor: "pointer", textAlign: "left", color: "#ef4444",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fef2f2"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Trash2 style={{ width: 13, height: 13 }} />
            Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

export default function Sidebar({
  activeConversationId,
  onSelectConversation,
  activeCortexConversationId,
  onSelectCortexConversation,
  activeForgeConversationId,
  onSelectForgeConversation,
  onOpenSettings,
  activeTab,
  onTabChange,
}: SidebarProps) {
  const queryClient = useQueryClient();

  const { data: conversations = [], isLoading: axisLoading } = useListOpenaiConversations();
  const { data: cortexConversations = [], isLoading: cortexLoading } = useListCortexConversations();
  const { data: forgeApps = [], isLoading: forgeLoading } = useListForgeConversations({
    query: { enabled: activeTab === "forge", queryKey: getListForgeConversationsQueryKey() },
  });

  const deleteAxisMutation = useDeleteOpenaiConversation();
  const deleteCortexMutation = useDeleteCortexConversation();
  const deleteForgeMutation = useDeleteForgeConversation();
  const renameAxisMutation = useRenameOpenaiConversation();
  const renameCortexMutation = useRenameCortexConversation();
  const renameForgeMutation = useRenameForgeConversation();
  const createForgeMutation = useCreateForgeConversation();

  // Rename state
  const [renameDialog, setRenameDialog] = useState<{ id: number; title: string; kind: ConvKind } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirmation state
  const [deleteDialog, setDeleteDialog] = useState<{ id: number; kind: ConvKind } | null>(null);

  const openRename = (id: number, title: string, kind: ConvKind) => {
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
    } else if (kind === "cortex") {
      renameCortexMutation.mutate({ id, data: { title: renameValue.trim() } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCortexConversationQueryKey(id) });
        },
      });
    } else {
      renameForgeMutation.mutate({ id, data: { title: renameValue.trim() } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForgeConversationQueryKey(id) });
        },
      });
    }
    setRenameDialog(null);
  };

  const openDelete = (id: number, kind: ConvKind) => {
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
    } else if (kind === "cortex") {
      deleteCortexMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
          if (activeCortexConversationId === id) onSelectCortexConversation(null);
        },
      });
    } else {
      deleteForgeMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
          if (activeForgeConversationId === id) onSelectForgeConversation(null);
        },
      });
    }
    setDeleteDialog(null);
  };

  const handleNewApp = async () => {
    const created = await createForgeMutation.mutateAsync({ data: { title: "New App" } });
    queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
    onSelectForgeConversation(created.id);
  };

  return (
    <>
      <div className="w-72 bg-sidebar border-r flex flex-col h-full flex-shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-primary font-semibold text-lg">
            {activeTab === "codex" ? "Axis" : activeTab === "cortex" ? "Cortex" : "Forge"}
          </div>
        </div>

        {activeTab !== "forge" && (
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
        )}

        <div className="p-3 pt-2">
          <Button
            className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-white font-medium shadow-sm"
            onClick={() => {
              if (activeTab === "codex") onSelectConversation(null);
              else if (activeTab === "cortex") onSelectCortexConversation(null);
              else handleNewApp();
            }}
          >
            <Plus className="w-4 h-4" />
            {activeTab === "forge" ? "New App" : "New Chat"}
          </Button>
        </div>

        {activeTab === "codex" ? (
          <div className="flex-1 overflow-y-auto px-3 min-h-0">
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
          </div>
        ) : activeTab === "cortex" ? (
          <div className="flex-1 overflow-y-auto px-3 min-h-0">
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
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-3 min-h-0">
            {forgeLoading ? (
              <div className="px-2 py-4 text-sm text-muted-foreground text-center">Loading...</div>
            ) : forgeApps.length === 0 ? (
              <div className="px-2 py-8 text-sm text-muted-foreground text-center">No apps yet</div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 pb-4">
                {forgeApps.map((app) => (
                  <AppTile
                    key={app.id}
                    app={{ id: app.id, title: app.title }}
                    isActive={activeForgeConversationId === app.id}
                    onSelect={() => onSelectForgeConversation(app.id)}
                    onRename={() => openRename(app.id, app.title, "forge")}
                    onDelete={() => openDelete(app.id, "forge")}
                  />
                ))}
              </div>
            )}
            <div className="text-center text-xs text-muted-foreground/70 pb-2">
              {forgeApps.length}/10 apps
            </div>
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
