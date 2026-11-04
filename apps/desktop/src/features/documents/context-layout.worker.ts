import { layoutContextGraph, type LayoutRequest } from "./context-layout";

self.onmessage = (
  event: MessageEvent<{ id: number; request: LayoutRequest }>,
) => {
  const { id, request } = event.data;
  try {
    self.postMessage({ id, positions: layoutContextGraph(request) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
