import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { windowClient } from "@/lib/api/window";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");

// The boot module: public/theme.js has painted the stored theme, so the window
// shows now, while the application's modules load.
void windowClient.show();
const [
  { App },
  { ChatClientContext },
  { createHostChatClient },
  { DraftRecoveryProvider },
] = await Promise.all([
  import("@/app/App"),
  import("@/features/chats/client"),
  import("@/features/chats/host-client"),
  import("@/lib/draft-recovery"),
]).catch((error: unknown) => {
  showStartupFailure();
  throw error;
});
void windowClient.booted();
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
} else if ("__TAURI_INTERNALS__" in window) {
  // Inside the desktop shell the backend owns Chat; elsewhere Chat reads as off.
  applicationRoot.render(
    <StrictMode>
      <DraftRecoveryProvider>
        <ChatClientContext value={createHostChatClient()}>
          <App />
        </ChatClientContext>
      </DraftRecoveryProvider>
    </StrictMode>,
  );
} else {
  applicationRoot.render(
    <StrictMode>
      <DraftRecoveryProvider>
        <App />
      </DraftRecoveryProvider>
    </StrictMode>,
  );
}

/** The page the native watchdog would show; React has not replaced it yet. */
function showStartupFailure() {
  const script = document.createElement("script");
  script.src = "/startup-fallback.js";
  document.head.append(script);
}
