import { windowClient } from "@/lib/api/window";
import { themeFade } from "@/lib/motion-tokens";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";

/** Personal, per-computer interface choices. They never leave this machine. */
const preferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).catch("system"),
  openTickets: z.enum(["split", "expanded"]).catch("split"),
  /** Read a Document beside the list ("split") or at full width ("expanded"); the reader's toggle sets it. */
  openDocuments: z.enum(["split", "expanded"]).catch("split"),
  ticketLayout: z.enum(["list", "board"]).catch("list"),
  sidebarCollapsed: z.boolean().catch(false),
  ticketRows: z.enum(["detailed", "simple"]).catch("simple"),
  followCreated: z.boolean().catch(true),
  /** The Experimental Chat switch. The desktop backend is told at startup. */
  chat: z.boolean().catch(false),
  /** Settings > Attention > Chat notifications. On by default; it takes effect once notifications are allowed. */
  notifyChats: z.boolean().catch(true),
  /** What Documents opens on: the work in progress, or the Documents opened lately. */
  documentsView: z.enum(["current", "recent"]).catch("current"),
  /** The order of Recent. */
  documentsSort: z.enum(["opened", "updated", "title"]).catch("opened"),
  /** Which Current work groups are open, by Plan id or `finished`; unset follows the default. */
  documentGroups: z.record(z.string(), z.boolean()).catch({}),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type ThemePreference = Preferences["theme"];
export type OpenTicketsPreference = Preferences["openTickets"];

const STORAGE_KEY = "ticketd.preferences";
const DEFAULTS: Preferences = {
  theme: "system",
  openTickets: "split",
  openDocuments: "split",
  ticketLayout: "list",
  sidebarCollapsed: false,
  ticketRows: "simple",
  followCreated: true,
  chat: false,
  notifyChats: true,
  documentsView: "current",
  documentsSort: "opened",
  documentGroups: {},
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

const FADING_ATTRIBUTE = "data-theme-fading";
let fadeTimer: number | undefined;

/**
 * Moves the window to another theme: every color crossfades over `--dur-theme`
 * (styles.css). `data-theme-fading` on the root switches that transition on
 * for the length of the fade only, so launch and ordinary hovers are untouched.
 * The window color behind a transparent macOS title bar is set by the window
 * client at once; CSS cannot fade it. Reduced motion or a held key zeroes the token, and the
 * theme then changes in one frame. Launch uses `applyTheme` and never fades.
 */
export function changeTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  const fade = themeFade();
  if (root.dataset.theme === resolved || !fade) {
    applyTheme(resolved);
    return;
  }
  window.clearTimeout(fadeTimer);
  root.setAttribute(FADING_ATTRIBUTE, "");
  applyTheme(resolved);
  fadeTimer = window.setTimeout(
    () => root.removeAttribute(FADING_ATTRIBUTE),
    fade * 1000,
  );
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

const SYSTEM_THEME_KEY = "ticketd.system-theme";

function recallSystemDark(): boolean | null {
  try {
    const raw = localStorage.getItem(SYSTEM_THEME_KEY);
    return raw === "dark" ? true : raw === "light" ? false : null;
  } catch {
    return null;
  }
}

/**
 * Whether the operating system is dark right now: true, false, or null when
 * unknown. Light and Dark also set the native window theme, which changes what
 * the page's media query reports, so the query only speaks for the operating
 * system while the choice is System. It is remembered then and read back while
 * Light or Dark is chosen.
 */
export function useSystemDark(): boolean | null {
  const { theme } = usePreferences();
  const live = useSyncExternalStore(
    subscribeToSystemTheme,
    systemPrefersDark,
    () => false,
  );
  useEffect(() => {
    if (theme !== "system") return;
    try {
      localStorage.setItem(SYSTEM_THEME_KEY, live ? "dark" : "light");
    } catch {
      // Nothing to remember it in; the next System choice records it again.
    }
  }, [theme, live]);
  return theme === "system" ? live : recallSystemDark();
}

/** Keeps the document root in step with the choice and the operating system. */
export function useThemeSync() {
  const dark = useDarkTheme();
  const { theme } = usePreferences();
  // public/theme.js applies the stored theme before the first paint.
  useEffect(() => changeTheme(dark ? "dark" : "light"), [dark]);
  useEffect(() => syncWindowTheme(theme), [theme]);
  useEffect(() => syncWindowColor(dark ? "dark" : "light"), [dark]);
}

/**
 * The title bar and native dialogs follow the choice too; System hands
 * control back to the operating system.
 */
function syncWindowTheme(theme: ThemePreference) {
  void windowClient.setTheme(theme === "system" ? null : theme);
}

/** The transparent macOS title bar shows the window color: the canvas. */
function syncWindowColor(resolved: "light" | "dark") {
  void windowClient.setBackgroundColor(
    resolved === "dark" ? "#0A0A0A" : "#FAFAFA",
  );
}
