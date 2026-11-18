import "./styles.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { windowClient } from "@/lib/api/window";
import { installErrorReporter } from "@/lib/error-report";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root");

// Before anything else loads, so a failure while the modules load is recorded too.
const errors = installErrorReporter();

// The boot module: public/theme.js has painted the stored theme, so the window
// shows now, while the application's modules load.
void windowClient.show();
const [
  { App },
  { MotionProvider },
  { ChatClientContext },
  { createHostChatClient },
  { DraftRecoveryProvider },
] = await Promise.all([
  import("@/app/App"),
  import("@/components/ui/motion"),
  import("@/features/chats/client"),
  import("@/features/chats/host-client"),
  import("@/lib/draft-recovery"),
]).catch((error: unknown) => {
  showStartupFailure();
  throw error;
});
void windowClient.booted();
const applicationRoot = createRoot(root, {
  // React reports an error nothing caught here instead of to the window.
  onUncaughtError(error) {
    errors.report(error);
    console.error(error);
  },
});

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

/** The page the native watchdog would show; React has not replaced it yet. */
function showStartupFailure() {
  const script = document.createElement("script");
  script.src = "/startup-fallback.js";
  document.head.append(script);
}
