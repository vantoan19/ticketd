import { useSyncExternalStore } from "react";
import { useTheme } from "fumadocs-ui/provider/base";
import Landing from "@/Landing";
import "@/screens/app.css";
import "@/landing.css";

export function meta() {
  return [
    { title: "ticketd — a ticket factory on your computer" },
    {
      name: "description",
      content:
        "A ticket factory on your computer, powered by your AI. Your agent works through the CLI; you follow every change in the desktop app.",
    },
  ];
}

const subscribe = () => () => {};

/**
 * The landing page reads the window as it renders (theme, motion, layout), so
 * it is drawn in the browser only. The prerendered page is its paper ground.
 */
export default function Home() {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { resolvedTheme, setTheme } = useTheme();
  if (!mounted) return <div className="min-h-screen bg-fd-background" />;
  return (
    <Landing
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      onTheme={setTheme}
    />
  );
}
