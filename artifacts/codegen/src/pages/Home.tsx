import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import CortexArea from "@/components/CortexArea";
import AuthModal from "@/components/AuthModal";
import SettingsPanel from "@/components/SettingsPanel";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { LogIn } from "lucide-react";

type Tab = "codex" | "cortex";

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("codex");
  const { user, isLoading } = useAuth();

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <Sidebar
        activeConversationId={activeConversationId}
        onSelectConversation={setActiveConversationId}
        onOpenSettings={() => setShowSettings(true)}
        activeTab={activeTab}
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
        {activeTab === "codex" ? (
          <ChatArea
            conversationId={activeConversationId}
            onConversationCreated={(id) => setActiveConversationId(id)}
            onOpenAuth={() => setShowAuth(true)}
          />
        ) : (
          <CortexArea onOpenAuth={() => setShowAuth(true)} />
        )}
      </div>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
