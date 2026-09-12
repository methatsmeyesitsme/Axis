import { useState, useEffect, useRef, useCallback } from "react";
import { motion, useMotionValue, animate as animateMotionValue } from "framer-motion";
import Sidebar from "@/components/Sidebar";
import ForgeSidebar from "@/components/ForgeSidebar";
import ChatArea from "@/components/ChatArea";
import CortexArea from "@/components/CortexArea";
import ForgeArea from "@/components/ForgeArea";
import AuthModal from "@/components/AuthModal";
import SettingsPanel from "@/components/SettingsPanel";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { LogIn, Menu } from "lucide-react";

type Tab = "codex" | "cortex" | "forge";

interface DragState {
  status: "idle" | "pending" | "dragging";
  startX: number;
  startY: number;
  baseX: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

function MenuToggle({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Menu"
      className={`flex items-center justify-center w-8 h-8 rounded-lg bg-card border shadow-sm hover:bg-muted ${className}`}
    >
      <Menu className="w-4 h-4" />
    </button>
  );
}

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeCortexConversationId, setActiveCortexConversationId] = useState<number | null>(null);
  const [activeForgeConversationId, setActiveForgeConversationId] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("codex");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const { user, isLoading } = useAuth();

  const swipeTrackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const activeTabRef = useRef<Tab>(activeTab);
  activeTabRef.current = activeTab;

  const getWidth = useCallback(() => swipeTrackRef.current?.parentElement?.offsetWidth ?? window.innerWidth, []);

  const snapTo = useCallback(
    (nextTab: Tab) => {
      const width = getWidth();
      animateMotionValue(x, nextTab === "forge" ? -width : 0, { type: "spring", stiffness: 380, damping: 38 });
      if (nextTab !== activeTabRef.current) setActiveTab(nextTab);
    },
    [getWidth, x]
  );

  useEffect(() => {
    if (!isLoading) {
      setActiveConversationId(null);
      setActiveCortexConversationId(null);
      setActiveForgeConversationId(null);
    }
  }, [user, isLoading]);

  useEffect(() => {
    const el = swipeTrackRef.current;
    if (!el) return;

    const state: DragState = {
      status: "idle",
      startX: 0,
      startY: 0,
      baseX: 0,
      lastX: 0,
      lastTime: 0,
      velocity: 0,
    };

    const beginDrag = (clientX: number, clientY: number) => {
      state.status = "pending";
      state.startX = clientX;
      state.startY = clientY;
      state.baseX = x.get();
      state.lastX = clientX;
      state.lastTime = performance.now();
      state.velocity = 0;
    };

    const moveDrag = (clientX: number, clientY: number, evt: TouchEvent | MouseEvent) => {
      if (state.status === "idle") return;
      const dx = clientX - state.startX;
      const dy = clientY - state.startY;

      if (state.status === "pending") {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          state.status = "idle";
          return;
        }
        state.status = "dragging";
      }

      if (state.status !== "dragging") return;

      if (evt.cancelable) evt.preventDefault();
      const width = getWidth();
      let newX = state.baseX + dx;
      const min = -width;
      const max = 0;
      if (newX > max) newX = max + (newX - max) * 0.25;
      if (newX < min) newX = min + (newX - min) * 0.25;
      x.set(newX);

      const now = performance.now();
      const dt = now - state.lastTime;
      if (dt > 0) state.velocity = ((clientX - state.lastX) / dt) * 1000;
      state.lastX = clientX;
      state.lastTime = now;
    };

    const endDrag = () => {
      const wasDragging = state.status === "dragging";
      state.status = "idle";
      if (!wasDragging) return;

      const width = getWidth();
      const dx = state.lastX - state.startX;
      const distanceThreshold = width * 0.3;
      const velocityThreshold = 450;

      let nextTab: Tab = activeTabRef.current;
      if (activeTabRef.current === "codex" && (dx < -distanceThreshold || state.velocity < -velocityThreshold)) {
        nextTab = "forge";
      } else if (activeTabRef.current === "forge" && (dx > distanceThreshold || state.velocity > velocityThreshold)) {
        nextTab = "codex";
      }
      snapTo(nextTab);
    };

    let lastTouchTime = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchTime = Date.now();
      if (e.touches.length !== 1) return;
      beginDrag(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      lastTouchTime = Date.now();
      if (e.touches.length !== 1) return;
      moveDrag(e.touches[0].clientX, e.touches[0].clientY, e);
    };
    const onTouchEnd = () => {
      lastTouchTime = Date.now();
      endDrag();
    };
    const onTouchCancel = () => {
      lastTouchTime = Date.now();
      if (state.status === "dragging") snapTo(activeTabRef.current);
      state.status = "idle";
    };

    let mouseActive = false;
    const GHOST_EVENT_GUARD_MS = 800;
    const onMouseDown = (e: MouseEvent) => {
      if (Date.now() - lastTouchTime < GHOST_EVENT_GUARD_MS) return;
      if (e.button !== 0) return;
      mouseActive = true;
      beginDrag(e.clientX, e.clientY);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseActive) return;
      moveDrag(e.clientX, e.clientY, e);
    };
    const onMouseUp = () => {
      if (!mouseActive) return;
      mouseActive = false;
      endDrag();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [getWidth, x, snapTo]);

  const openSidebar = !sidebarCollapsed;
  const toggleSidebar = () => setSidebarCollapsed((v) => !v);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-background">
      {activeTab === "cortex" ? (
        <div className="h-full w-full flex flex-col min-w-0 relative">
          {sidebarCollapsed && (
            <div className="absolute top-3 left-2 z-20">
              <MenuToggle onClick={toggleSidebar} />
            </div>
          )}
          {!isLoading && !user && (
            <div className="absolute top-3 right-4 z-10">
              <Button
                size="sm"
                className="bg-primary hover:bg-primary/90 text-white shadow-sm gap-2"
                onClick={() => setShowAuth(true)}
              >
                <LogIn className="w-4 h-4" />
                Log in
              </Button>
            </div>
          )}
          <CortexArea
            conversationId={activeCortexConversationId}
            onConversationCreated={(id) => setActiveCortexConversationId(id)}
            onOpenAuth={() => setShowAuth(true)}
          />
        </div>
      ) : (
        <div className="h-full w-full relative overflow-hidden min-w-0">
          <motion.div
            ref={swipeTrackRef}
            className="flex h-full shrink-0"
            style={{ width: "200%", touchAction: "pan-y", x }}
          >
            <div style={{ width: "50%" }} className="h-full shrink-0 flex flex-col min-w-0 relative">
              {sidebarCollapsed && (
                <div className="absolute top-3 left-2 z-20">
                  <MenuToggle onClick={toggleSidebar} />
                </div>
              )}
              {!isLoading && !user && (
                <div className="absolute top-3 right-4 z-10">
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90 text-white shadow-sm gap-2"
                    onClick={() => setShowAuth(true)}
                  >
                    <LogIn className="w-4 h-4" />
                    Log in
                  </Button>
                </div>
              )}
              <ChatArea
                conversationId={activeConversationId}
                onConversationCreated={(id) => setActiveConversationId(id)}
                onOpenAuth={() => setShowAuth(true)}
                forgeHint
                onOpenForge={() => snapTo("forge")}
              />
            </div>

            <div style={{ width: "50%" }} className="h-full shrink-0 flex flex-col min-w-0 relative">
              {sidebarCollapsed && (
                <div className="absolute top-3 left-2 z-20">
                  <MenuToggle onClick={toggleSidebar} />
                </div>
              )}
              {!isLoading && !user && (
                <div className="absolute top-3 right-4 z-10">
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90 text-white shadow-sm gap-2"
                    onClick={() => setShowAuth(true)}
                  >
                    <LogIn className="w-4 h-4" />
                    Log in
                  </Button>
                </div>
              )}
              <ForgeArea
                conversationId={activeForgeConversationId}
                onConversationCreated={(id) => setActiveForgeConversationId(id)}
                onOpenAuth={() => setShowAuth(true)}
              />
            </div>
          </motion.div>
        </div>
      )}

      {/* Invisible hit target — closes menu on tap outside, no gray overlay */}
      {openSidebar && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarCollapsed(true)}
          className="fixed inset-0 z-40 bg-transparent"
        />
      )}

      <motion.div
        initial={false}
        animate={{ x: openSidebar ? 0 : -300 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
        className="fixed top-2 bottom-2 left-0 z-50 flex items-stretch pointer-events-none"
      >
        <aside className="relative pointer-events-auto h-full w-72 rounded-r-2xl border border-l-0 bg-sidebar overflow-visible">
          {/* Slightly thicker edge shadow: darkest at menu edge, fades out */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 left-full w-5"
            style={{
              background:
                "linear-gradient(to right, rgba(0,0,0,0.18), rgba(0,0,0,0.08) 35%, rgba(0,0,0,0.03) 70%, transparent)",
            }}
          />
          <div className="h-full w-full overflow-hidden rounded-r-2xl">
            {activeTab === "forge" ? (
              <ForgeSidebar
                activeForgeConversationId={activeForgeConversationId}
                onSelectForgeConversation={(id) => {
                  setActiveForgeConversationId(id);
                  setSidebarCollapsed(true);
                }}
                onOpenSettings={() => {
                  setShowSettings(true);
                  setSidebarCollapsed(true);
                }}
              />
            ) : (
              <Sidebar
                activeConversationId={activeConversationId}
                onSelectConversation={(id) => {
                  setActiveConversationId(id);
                  setSidebarCollapsed(true);
                }}
                activeCortexConversationId={activeCortexConversationId}
                onSelectCortexConversation={(id) => {
                  setActiveCortexConversationId(id);
                  setSidebarCollapsed(true);
                }}
                onOpenSettings={() => {
                  setShowSettings(true);
                  setSidebarCollapsed(true);
                }}
                activeTab={activeTab === "cortex" ? "cortex" : "codex"}
                onTabChange={(tab) => setActiveTab(tab)}
              />
            )}
          </div>
        </aside>

        {openSidebar && (
          <div className="pointer-events-auto flex items-start pt-1 pl-2">
            <MenuToggle onClick={toggleSidebar} />
          </div>
        )}
      </motion.div>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
