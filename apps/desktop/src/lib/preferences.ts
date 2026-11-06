import { windowClient } from "@/lib/api/window";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";

/** Personal, per-computer interface choices. They never leave this machine. */
const preferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).catch("system"),
  openTickets: z.enum(["split", "expanded"]).catch("split"),
  followCreated: z.boolean().catch(true),
  notifyReminders: z.boolean().catch(false),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type ThemePreference = Preferences["theme"];
export type OpenTicketsPreference = Preferences["openTickets"];

const STORAGE_KEY = "ticketd.preferences";
const DEFAULTS: Preferences = {
  theme: "system",
  openTickets: "split",
  followCreated: true,
  notifyReminders: false,
};
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Unreadable or unknown stored values fall back to the defaults. */
function parsePreferences(raw: string | null): Preferences {
  if (raw === null) return DEFAULTS;
  try {
    return preferencesSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

export function loadPreferences(): Preferences {
  return parsePreferences(readRaw());
}

/** Light or Dark for a theme choice; System follows the operating system. */
export function resolveTheme(
  theme: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/**
 * Applies the resolved theme at the document root. `data-theme` drives the
 * color tokens and `color-scheme` (native menus, scrollbars); the `dark`
 * class drives Tailwind's `dark:` variants.
 */
export function applyTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

const listeners = new Set<() => void>();
let snapshotRaw: string | null | undefined;
let snapshot: Preferences = DEFAULTS;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The snapshot is cached per stored string so React sees a stable object.
function getSnapshot(): Preferences {
  const raw = readRaw();
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = parsePreferences(raw);
  }
  return snapshot;
}

/**
 * Stores one choice. Returns false when it could not be saved; the choice then
 * stays unchanged, so the control never shows a value that will not persist.
 */
export function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...getSnapshot(), [key]: value }),
    );
  } catch {
    return false;
  }
  listeners.forEach((listener) => listener());
  return true;
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);
}

function subscribeToSystemTheme(listener: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** True when the resolved theme is dark (the choice, else the operating system). */
export function useDarkTheme(): boolean {
  const { theme } = usePreferences();
  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    systemPrefersDark,
    () => false,
  );
  return resolveTheme(theme, systemDark) === "dark";
}

/** Keeps the document root in step with the choice and the operating system. */
export function useThemeSync() {
  const dark = useDarkTheme();
  const { theme } = usePreferences();
  // main.tsx applies the stored theme before the first paint.
  useEffect(() => applyTheme(dark ? "dark" : "light"), [dark]);
  // The title bar and native dialogs follow the choice too; System hands
  // control back to the operating system.
  useEffect(() => {
    void windowClient.setTheme(theme === "system" ? null : theme);
  }, [theme]);
  // The transparent macOS title bar shows the window color: the canvas.
  useEffect(() => {
    void windowClient.setBackgroundColor(dark ? "#0A0A0A" : "#FAFAFA");
  }, [dark]);
}

/** Applies the stored theme before the first render. */
export function applyStoredTheme() {
  applyTheme(resolveTheme(loadPreferences().theme, systemPrefersDark()));
}
