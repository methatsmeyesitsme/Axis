import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useListForgeConversations,
  useCreateForgeConversation,
  useDeleteForgeConversation,
  useRenameForgeConversation,
  getListForgeConversationsQueryKey,
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
import { Plus, Settings, MoreVertical, Pencil, Trash2, Hammer, ChevronRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface ForgeSidebarProps {
  activeForgeConversationId: number | null;
  onSelectForgeConversation: (id: number | null) => void;
  onOpenSettings: () => void;
}

interface AppItem {
  id: number;
  title: string;
}

function AppTile({
  app,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  app: AppItem;
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

export default function ForgeSidebar({
  activeForgeConversationId,
  onSelectForgeConversation,
  onOpenSettings,
}: ForgeSidebarProps) {
  const queryClient = useQueryClient();

  const { data: forgeApps = [], isLoading: forgeLoading } = useListForgeConversations({
    query: { queryKey: getListForgeConversationsQueryKey() },
  });
  const createForgeMutation = useCreateForgeConversation();
  const deleteForgeMutation = useDeleteForgeConversation();
  const renameForgeMutation = useRenameForgeConversation();

  const [renameDialog, setRenameDialog] = useState<{ id: number; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ id: number } | null>(null);
  const recentDeleteTimestampsRef = useRef<number[]>([]);
  const RAPID_DELETE_WINDOW_MS = 60_000;
  const RAPID_DELETE_THRESHOLD = 3;

  const openRename = (id: number, title: string) => {
    setRenameValue(title);
    setRenameDialog({ id, title });
  };

  const confirmRename = () => {
    if (!renameDialog || !renameValue.trim()) return;
    const { id } = renameDialog;
    renameForgeMutation.mutate({ id, data: { title: renameValue.trim() } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetForgeConversationQueryKey(id) });
      },
    });
    setRenameDialog(null);
  };

  const performDelete = (id: number) => {
    deleteForgeMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
        if (activeForgeConversationId === id) onSelectForgeConversation(null);
      },
    });
    const now = Date.now();
    recentDeleteTimestampsRef.current = [...recentDeleteTimestampsRef.current, now].filter(
      (t) => now - t < RAPID_DELETE_WINDOW_MS
    );
  };

  const openDelete = (id: number) => {
    const now = Date.now();
    const recent = recentDeleteTimestampsRef.current.filter((t) => now - t < RAPID_DELETE_WINDOW_MS);
    recentDeleteTimestampsRef.current = recent;
    // After 3 confirmed deletes within the last minute, skip the dialog and delete immediately.
    // Once a minute passes without hitting that pace again, the window ages out and confirmation returns.
    if (recent.length >= RAPID_DELETE_THRESHOLD) {
      performDelete(id);
      return;
    }
    setDeleteDialog({ id });
  };

  const confirmDelete = () => {
    if (!deleteDialog) return;
    performDelete(deleteDialog.id);
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
        <div className="p-4 border-b flex items-center gap-2">
          <div className="flex items-center gap-2 text-primary font-semibold text-lg">Forge</div>
        </div>

        <div className="p-3 pt-3">
          <Button
            className="w-full justify-start gap-2 bg-primary hover:bg-primary/90 text-white font-medium shadow-sm"
            onClick={handleNewApp}
          >
            <Plus className="w-4 h-4" />
            New App
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 min-h-0" style={{ touchAction: "pan-y" }}>
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
                  onRename={() => openRename(app.id, app.title)}
                  onDelete={() => openDelete(app.id)}
                />
              ))}
            </div>
          )}
          <div className="text-center text-xs text-muted-foreground/70 pb-2">
            {forgeApps.length}/10 apps
          </div>
        </div>

        <div className="shrink-0">
          <div className="mx-3 border-t" />
          <div className="p-3 flex flex-col gap-1">
            <button
              onClick={onOpenSettings}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Settings className="w-4 h-4 shrink-0" />
              Settings
            </button>
            <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground/60 select-none py-1">
              Swipe right for Codex
              <ChevronRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </div>
      </div>

      <Dialog open={!!renameDialog} onOpenChange={(open) => { if (!open) setRenameDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename app</DialogTitle>
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

      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => { if (!open) setDeleteDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this app?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the app, its files, its conversation, and all its data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteDialog(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
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
