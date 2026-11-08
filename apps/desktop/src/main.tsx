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
} else {
  applicationRoot.render(
    <StrictMode>
      <DraftRecoveryProvider>
        <App />
      </DraftRecoveryProvider>
    </StrictMode>,
  );
}
