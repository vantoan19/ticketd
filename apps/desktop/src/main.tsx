import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { applyStoredTheme } from "@/lib/preferences";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";
import { keepWebviewInStep } from "@/lib/webview-scale";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");

applyStoredTheme();
keepWebviewInStep();
const applicationRoot = createRoot(root);
if (import.meta.env.DEV && window.location.hash === "#plate-prototype") {
  void import("@/features/markdown/PlatePrototype").then(
    ({ PlatePrototype }) => {
      applicationRoot.render(
        <StrictMode>
          <PlatePrototype />
        </StrictMode>,
      );
    },
  );
} else if (import.meta.env.DEV && window.location.hash === "#chat-fixtures") {
  // The Chat screens over in-memory fixtures; no harness is started.
  void Promise.all([
    import("@/features/chats/fixtures"),
    import("@/features/chats/client"),
  ]).then(([{ fixtureChatClient }, { ChatClientContext }]) => {
    applicationRoot.render(
      <StrictMode>
        <DraftRecoveryProvider>
          <ChatClientContext value={fixtureChatClient()}>
            <App />
          </ChatClientContext>
        </DraftRecoveryProvider>
      </StrictMode>,
    );
  });
} else {
  applicationRoot.render(
    <StrictMode>
      <DraftRecoveryProvider>
        <App />
      </DraftRecoveryProvider>
    </StrictMode>,
  );
}
