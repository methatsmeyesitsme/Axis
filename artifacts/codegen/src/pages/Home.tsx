import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";

export default function Home() {
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <Sidebar 
        activeConversationId={activeConversationId} 
        onSelectConversation={setActiveConversationId} 
      />
      <div className="flex-1 flex flex-col min-w-0">
        <ChatArea 
          conversationId={activeConversationId}
          onConversationCreated={(id) => setActiveConversationId(id)}
        />
      </div>
    </div>
  );
}
