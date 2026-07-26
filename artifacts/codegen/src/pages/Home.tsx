import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
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

  const swipeContainerRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  useEffect(() => {
    const el = swipeContainerRef.current;
    if (!el) return;
    const update = () => setPaneWidth(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      const { offset, velocity } = info;
      const distanceThreshold = paneWidth * 0.3;
      const velocityThreshold = 450;

      if (activeTab === "codex") {
        if (offset.x < -distanceThreshold || velocity.x < -velocityThreshold) {
          setActiveTab("forge");
        }
      } else if (activeTab === "forge") {
        if (offset.x > distanceThreshold || velocity.x > velocityThreshold) {
          setActiveTab("codex");
        }
      }
    },
    [activeTab, paneWidth]
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
            style={{ width: "200%", touchAction: "pan-y" }}
            drag="x"
            dragConstraints={{ left: -paneWidth, right: 0 }}
            dragElastic={0.08}
            dragDirectionLock
            animate={{ x: activeTab === "forge" ? -paneWidth : 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
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
