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
import { LogIn } from "lucide-react";

type Tab = "codex" | "cortex" | "forge";

interface DragState {
  status: "idle" | "pending" | "dragging";
  startX: number;
  startY: number;
  baseX: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  pointerId: number | null;
}

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeCortexConversationId, setActiveCortexConversationId] = useState<number | null>(null);
  const [activeForgeConversationId, setActiveForgeConversationId] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("codex");
  const { user, isLoading } = useAuth();

  // Fully manual, low-level pointer-event swipe. Not using framer-motion's `drag`
  // prop at all — that turned out to have gesture-recognition quirks that were
  // hard to pin down (and framer's `drag` may not compose predictably inside
  // wrapping webviews like Replit's mobile app shell). `x` is a plain pixel
  // motion value we drive ourselves; listeners are attached natively with
  // {passive:false} so preventDefault reliably stops native scroll during a
  // horizontal drag — React's synthetic touch handlers are passive by default
  // and can silently fail to do this, which is a classic source of exactly this
  // kind of inconsistent, hard-to-reproduce swipe bug.
  const swipeTrackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const activeTabRef = useRef<Tab>(activeTab);
  activeTabRef.current = activeTab;

  const getWidth = useCallback(() => swipeTrackRef.current?.parentElement?.offsetWidth ?? window.innerWidth, []);

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
      pointerId: null,
    };

    const snapTo = (nextTab: Tab) => {
      const width = getWidth();
      animateMotionValue(x, nextTab === "forge" ? -width : 0, { type: "spring", stiffness: 380, damping: 38 });
      if (nextTab !== activeTabRef.current) setActiveTab(nextTab);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      state.status = "pending";
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.baseX = x.get();
      state.lastX = e.clientX;
      state.lastTime = performance.now();
      state.velocity = 0;
      state.pointerId = e.pointerId;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (state.status === "idle" || state.pointerId !== e.pointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (state.status === "pending") {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical intent — this isn't a pane swipe, let native scroll handle it.
          state.status = "idle";
          return;
        }
        state.status = "dragging";
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }

      if (state.status !== "dragging") return;

      e.preventDefault();
      const width = getWidth();
      let newX = state.baseX + dx;
      const min = -width;
      const max = 0;
      if (newX > max) newX = max + (newX - max) * 0.25;
      if (newX < min) newX = min + (newX - min) * 0.25;
      x.set(newX);

      const now = performance.now();
      const dt = now - state.lastTime;
      if (dt > 0) state.velocity = ((e.clientX - state.lastX) / dt) * 1000;
      state.lastX = e.clientX;
      state.lastTime = now;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (state.pointerId !== e.pointerId) return;
      const wasDragging = state.status === "dragging";
      state.status = "idle";
      state.pointerId = null;
      if (!wasDragging) return;

      const width = getWidth();
      const dx = e.clientX - state.startX;
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

    const onPointerCancel = () => {
      if (state.status === "dragging") snapTo(activeTabRef.current);
      state.status = "idle";
      state.pointerId = null;
    };

    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("pointermove", onPointerMove, { passive: false });
    el.addEventListener("pointerup", onPointerUp, { passive: true });
    el.addEventListener("pointercancel", onPointerCancel, { passive: true });

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [getWidth, x]);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      {activeTab === "cortex" ? (
        <>
          <Sidebar
            activeConversationId={activeConversationId}
            onSelectConversation={setActiveConversationId}
            activeCortexConversationId={activeCortexConversationId}
            onSelectCortexConversation={setActiveCortexConversationId}
            onOpenSettings={() => setShowSettings(true)}
            activeTab="cortex"
            onTabChange={setActiveTab}
          />
          <div className="flex-1 flex flex-col min-w-0 relative">
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
        </>
      ) : (
        // Codex and Forge live together as one sliding strip: each "pane" is a full
        // row (its own sidebar + its own content), so swiping moves the whole thing
        // as a single smooth unit rather than the sidebar and content moving separately.
        // min-w-0 here is critical: without it, a flex child won't shrink below its
        // content's natural size, so overflow-hidden has nothing to actually clip —
        // this was the real cause of both panes staying visible at once.
        <div className="flex-1 relative overflow-hidden flex min-w-0">
          <motion.div
            ref={swipeTrackRef}
            className="flex h-full shrink-0"
            style={{ width: "200%", touchAction: "pan-y", x }}
          >
            <div style={{ width: "50%" }} className="h-full shrink-0 flex min-w-0">
              <Sidebar
                activeConversationId={activeConversationId}
                onSelectConversation={setActiveConversationId}
                activeCortexConversationId={activeCortexConversationId}
                onSelectCortexConversation={setActiveCortexConversationId}
                onOpenSettings={() => setShowSettings(true)}
                activeTab="codex"
                onTabChange={setActiveTab}
              />
              <div className="flex-1 flex flex-col min-w-0 relative">
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
                />
              </div>
            </div>

            <div style={{ width: "50%" }} className="h-full shrink-0 flex min-w-0">
              <ForgeSidebar
                activeForgeConversationId={activeForgeConversationId}
                onSelectForgeConversation={setActiveForgeConversationId}
                onOpenSettings={() => setShowSettings(true)}
              />
              <div className="flex-1 flex flex-col min-w-0 relative">
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
            </div>
          </motion.div>
        </div>
      )}

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
