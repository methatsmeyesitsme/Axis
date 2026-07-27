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
}

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeCortexConversationId, setActiveCortexConversationId] = useState<number | null>(null);
  const [activeForgeConversationId, setActiveForgeConversationId] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("codex");
  const { user, isLoading } = useAuth();

  // Fully manual swipe using raw Touch Events (+ mouse events for desktop),
  // not the Pointer Events API and not framer-motion's `drag` prop. Touch
  // Events are the older, far more consistently-supported API across mobile
  // WebViews (including WebKit/iOS) — Pointer Events, while the modern
  // standard, have historically had less reliable support in some embedded
  // webviews, which is the likely reason swipe worked in Chromium-based
  // testing but not in Replit's actual mobile app shell. `x` is a plain pixel
  // motion value driven directly; listeners are attached natively with
  // {passive:false} on touchmove so preventDefault reliably stops native
  // scroll during a horizontal drag.
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
          // Vertical intent — this isn't a pane swipe, let native scroll handle it.
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

    // ── Touch (primary — mobile) ──────────────────────────────────────────
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

    // ── Mouse (desktop/testing) ───────────────────────────────────────────
    // Mobile browsers fire synthetic "ghost" mouse events (mousedown/move/up)
    // shortly after a real touch gesture, for compatibility with old sites
    // that only listen for mouse events. Without guarding against these, a
    // real touch swipe gets processed correctly, then a synthetic mouse
    // sequence fires moments later with near-zero elapsed time (and thus an
    // artificially huge computed velocity), occasionally flipping the tab
    // back before a real re-render corrects it — exactly the "swipes,
    // teleports back, swipes again" glitch. Ignoring mouse events shortly
    // after any touch activity fixes this.
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
                  onOpenForge={() => snapTo("forge")}
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
