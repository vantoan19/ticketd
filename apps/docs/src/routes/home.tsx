import type { Route } from "./+types/home";
import { getReleases, platformDownloads } from "../lib/releases.server";
import { useRef } from "react";
import { Journey } from "../journey/Journey";
import { Destination, Foundations } from "../journey/Destination";
import { JourneyTrack } from "../journey/JourneyTrack";
import "../journey/journey.css";
import { Hero } from "../demo/Hero";
import sprite from "virtual:ticketd-art";
import "../demo/hero.css";

export const links: Route.LinksFunction = () => [
  {
    // External SVG <use> requests a same-origin document. A regular image
    // preload has a different fetch mode and can download it twice in WebKit.
    rel: "prefetch",
    as: "image",
    type: "image/svg+xml",
    href: sprite,
    fetchPriority: "high",
  },
];

export function meta() {
  return [
    { title: "ticketd · A ticket workspace for you and your AI agents" },
    {
      name: "description",
      content:
        "Plan work with Claude Code and Codex, follow each ticket, and review the result. A free, open-source desktop app and CLI.",
    },
  ];
}
export async function loader() {
  const data = platformDownloads(await getReleases());
  return {
    available: Object.values(data.groups).some((s) => s.desktop !== null),
  };
}
export default function Home({
  loaderData: { available },
}: Route.ComponentProps) {
  const story = useRef<HTMLElement>(null);
  return (
    <main id="main-content" className="landing-story" ref={story} tabIndex={-1}>
      <Hero available={available} />
      <Journey />
      <Destination available={available} />
      <JourneyTrack story={story} />
      <Foundations />
    </main>
  );
}
