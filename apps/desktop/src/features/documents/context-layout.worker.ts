import { layoutContextGraph, type LayoutRequest } from "./context-layout";

self.onmessage = (
  event: MessageEvent<{ id: number; request: LayoutRequest }>,
) => {
  const { id, request } = event.data;
  try {
    self.postMessage({ id, positions: layoutContextGraph(request) });
  } catch (error) {
    // Internal: the page shows this only under Details.
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "Layout failed.",
    });
  }
};
