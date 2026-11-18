import "./styles.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { MotionProvider } from "@/components/ui/motion";
import { ChatClientContext } from "@/features/chats/client";
import { createHostChatClient } from "@/features/chats/host-client";
import { applyStoredTheme } from "@/lib/preferences";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");

void applyStoredTheme();
const applicationRoot = createRoot(root);

/** Every way the app starts renders inside the one motion provider. */
function render(children: ReactNode) {
  applicationRoot.render(
    <StrictMode>
      <MotionProvider>{children}</MotionProvider>
    </StrictMode>,
  );
}

if (import.meta.env.DEV && window.location.hash === "#plate-prototype") {
  void import("@/features/markdown/PlatePrototype").then(({ PlatePrototype }) =>
    render(<PlatePrototype />),
  );
} else if (import.meta.env.DEV && window.location.hash === "#chat-fixtures") {
  // The Chat screens over in-memory fixtures; no harness is started.
  void Promise.all([
    import("@/features/chats/fixtures"),
    import("@/features/chats/client"),
  ]).then(([{ fixtureChatClient }, { ChatClientContext }]) => {
    render(
      <DraftRecoveryProvider>
        <ChatClientContext value={fixtureChatClient()}>
          <App />
        </ChatClientContext>
      </DraftRecoveryProvider>,
    );
  });
} else if ("__TAURI_INTERNALS__" in window) {
  // Inside the desktop shell the backend owns Chat; elsewhere Chat reads as off.
  render(
    <DraftRecoveryProvider>
      <ChatClientContext value={createHostChatClient()}>
        <App />
      </ChatClientContext>
    </DraftRecoveryProvider>,
  );
} else {
  render(
    <DraftRecoveryProvider>
      <App />
    </DraftRecoveryProvider>,
  );
}
