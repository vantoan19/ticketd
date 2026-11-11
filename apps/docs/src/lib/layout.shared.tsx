import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { links } from "@/links";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="text-[19px] font-semibold tracking-[-0.05em]">
          ticketd
        </span>
      ),
      url: "/",
    },
    githubUrl: links.repository,
  };
}
