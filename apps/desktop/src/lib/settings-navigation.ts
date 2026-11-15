import { createContext } from "react";
import type { SettingsPageId } from "@/features/settings/settings-sections";

/**
 * Opens one Settings page from anywhere, for a fix that lives there: "Change
 * limit" opens Attachments, "Set up Google Drive" opens Google Drive. Null
 * outside the app shell (a test, a preview), where the link is left out.
 */
export const SettingsNavigation = createContext<
  ((page: SettingsPageId) => void) | null
>(null);
