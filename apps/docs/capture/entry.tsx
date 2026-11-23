import "./fixture";
import "../../desktop/src/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "../../desktop/src/app/App";
import { MotionProvider } from "../../desktop/src/components/ui/motion";
import { DraftRecoveryProvider } from "../../desktop/src/lib/draft-recovery";
import { installWidthQueries } from "../../desktop/src/lib/width-queries";
import { ChatClientContext } from "../../desktop/src/features/chats/client";
import { createMockChatClient } from "../../desktop/src/features/chats/mock-client";
installWidthQueries(document.body);
createRoot(document.getElementById("root")!).render(
  <MotionProvider>
    <DraftRecoveryProvider>
      <ChatClientContext
        value={createMockChatClient({ enabled: window.captureAutomations })}
      >
        <App />
      </ChatClientContext>
    </DraftRecoveryProvider>
  </MotionProvider>,
);
