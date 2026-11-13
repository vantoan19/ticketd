import { useEffect, useState } from "react";
import { cn } from "cn";
import { workspaceClient, type ProjectFavicon } from "@/lib/api/workspace";
import { readsAsShape } from "@/features/projects/favicon";
import "./projects.css";

/** How a favicon is drawn: its shape in the text color, or its picture in grays. */
type Look = { url: string; shape: boolean };

/**
 * Probed once per Project while the app runs and kept only in memory: the
 * favicon belongs to the folder, so ticketd never stores it.
 */
const looks = new Map<string, Promise<Look | null>>();

/** Whether the image reads as its shape alone; see `readsAsShape`. */
function transparent(url: string, svg: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      try {
        const context = canvas.getContext("2d");
        // No canvas: guess from the format.
        if (!context) return resolve(svg);
        context.drawImage(image, 0, 0, 16, 16);
        resolve(readsAsShape(context.getImageData(0, 0, 16, 16).data));
      } catch {
        resolve(svg);
      }
    };
    image.onerror = () => resolve(svg);
    image.src = url;
  });
}

async function load(favicon: ProjectFavicon | null): Promise<Look | null> {
  if (!favicon) return null;
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(favicon.bytes)], { type: favicon.mime }),
  );
  return {
    url,
    shape: await transparent(url, favicon.mime === "image/svg+xml"),
  };
}

function useFavicon(id: string): Look | null {
  const [look, setLook] = useState<{ id: string; look: Look | null } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    let pending = looks.get(id);
    if (!pending) {
      pending = workspaceClient.projectIcon(id).then(load, () => null);
      looks.set(id, pending);
    }
    void pending.then((found) => current && setLook({ id, look: found }));
    return () => {
      current = false;
    };
  }, [id]);
  return look?.id === id ? look.look : null;
}

/**
 * A Project's icon, from its folder's favicon: a transparent one as its shape
 * in the text color, an opaque one in grays on the boundary ring, and without
 * one a letter tile. Never the favicon's colors. 16px, or 20px on cards.
 */
export function ProjectIcon({
  project,
  size = 16,
  className,
}: {
  project: { id: string; title: string };
  size?: 16 | 20;
  className?: string;
}) {
  const look = useFavicon(project.id);
  const props = {
    "aria-hidden": true,
    "data-size": size,
    className: cn("project-icon", className),
  } as const;
  if (!look)
    return (
      <span {...props} data-look="letter">
        {Array.from(project.title.trim())[0]?.toUpperCase() ?? "?"}
      </span>
    );
  if (look.shape)
    return (
      <span
        {...props}
        data-look="shape"
        style={{
          maskImage: `url("${look.url}")`,
          WebkitMaskImage: `url("${look.url}")`,
        }}
      />
    );
  return (
    <span {...props} data-look="picture">
      <img alt="" src={look.url} />
    </span>
  );
}
