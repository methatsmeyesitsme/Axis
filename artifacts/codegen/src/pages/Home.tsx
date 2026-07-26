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

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [activeCortexConversationId, setActiveCortexConversationId] = useState<number | null>(null);
  const [activeForgeConversationId, setActiveForgeConversationId] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("codex");
  const { user, isLoading } = useAuth();

  // Fully hand-rolled swipe (rather than relying on framer-motion's drag+animate
  // composition, which turned out to fight itself and break swipe-right): `x` is
  // a plain motion value in pixels that we drive ourselves, and the resting
  // position after any drag is computed from a FRESH width measurement taken at
  // that exact moment — never a value that could be stale.
  const swipeContainerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);

  const getWidth = useCallback(() => swipeContainerRef.current?.offsetWidth ?? window.innerWidth, []);

  // Only used for elastic drag resistance bounds — the actual snap target is
  // always freshly measured (see snapTo/handleDragEnd), so staleness here can't
  // cause a wrong resting position, only a slightly-off elastic feel at worst.
  const [constraintWidth, setConstraintWidth] = useState(0);
  useEffect(() => {
    const update = () => setConstraintWidth(getWidth());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [getWidth]);

  useEffect(() => {
    if (!isLoading) {
      setActiveConversationId(null);
      setActiveCortexConversationId(null);
      setActiveForgeConversationId(null);
    }
  }, [user, isLoading]);

  // Velocity-based swipe: a fast flick crosses the threshold even with a small
  // drag distance; a slow drag needs to cross further before it commits.
  const handleDragEnd = useCallback(
    (_e: unknown, info: { offset: { x: number }; velocity: { x: number } }) => {
      const width = getWidth();
      const distanceThreshold = width * 0.3;
      const velocityThreshold = 450;
      const { offset, velocity } = info;

      let nextTab: Tab = activeTab;
      if (activeTab === "codex" && (offset.x < -distanceThreshold || velocity.x < -velocityThreshold)) {
        nextTab = "forge";
      } else if (activeTab === "forge" && (offset.x > distanceThreshold || velocity.x > velocityThreshold)) {
        nextTab = "codex";
      }

      animateMotionValue(x, nextTab === "forge" ? -width : 0, { type: "spring", stiffness: 380, damping: 38 });
      if (nextTab !== activeTab) setActiveTab(nextTab);
    },
    [activeTab, getWidth, x]
  );

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
        <div ref={swipeContainerRef} className="flex-1 relative overflow-hidden flex">
          <motion.div
            className="flex h-full"
            style={{ width: "200%", touchAction: "pan-y", x }}
            drag="x"
            dragConstraints={{ left: -constraintWidth, right: 0 }}
            dragElastic={0.08}
            dragDirectionLock
            dragMomentum={false}
            onDragEnd={handleDragEnd}
          >
            <div style={{ width: "50%" }} className="h-full shrink-0 flex">
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

            <div style={{ width: "50%" }} className="h-full shrink-0 flex">
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
