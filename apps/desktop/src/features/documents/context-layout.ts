export type Point = { x: number; y: number };
export type LayoutRequest = {
  nodes: string[];
  edges: { source: string; target: string }[];
  positions: Record<string, Point>;
};

// A bounded force layout accepts cycles and leaves already positioned nodes fixed.
export function layoutContextGraph(
  request: LayoutRequest,
): Record<string, Point> {
  const ids = [...request.nodes].sort();
  const points: Record<string, Point> = {};
  // Enough circumference that a dense neighborhood does not start overlapped.
  const radius = Math.max(220, ids.length * 24);
  ids.forEach((id, index) => {
    const existing = request.positions[id];
    const angle = (2 * Math.PI * index) / Math.max(ids.length, 1);
    points[id] = existing
      ? { ...existing }
      : {
          x: 400 + radius * Math.cos(angle),
          y: 240 + radius * Math.sin(angle),
        };
  });
  for (let iteration = 0; iteration < 100; iteration++) {
    const forces: Record<string, Point> = Object.fromEntries(
      ids.map((id) => [id, { x: 0, y: 0 }]),
    );
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points[ids[i]!]!;
        const b = points[ids[j]!]!;
        let dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx === 0 && dy === 0) dx = 0.01;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const force = Math.min(10, 10000 / (distance * distance));
        forces[ids[i]!]!.x += (dx / distance) * force;
        forces[ids[i]!]!.y += (dy / distance) * force;
        forces[ids[j]!]!.x -= (dx / distance) * force;
        forces[ids[j]!]!.y -= (dy / distance) * force;
      }
    }
    for (const edge of request.edges) {
      const a = points[edge.source];
      const b = points[edge.target];
      if (!a || !b || edge.source === edge.target) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = Math.max(-5, Math.min(5, (distance - 180) * 0.02));
      forces[edge.source]!.x += (dx / distance) * force;
      forces[edge.source]!.y += (dy / distance) * force;
      forces[edge.target]!.x -= (dx / distance) * force;
      forces[edge.target]!.y -= (dy / distance) * force;
    }
    for (const id of ids) {
      if (request.positions[id]) continue;
      points[id]!.x += forces[id]!.x;
      points[id]!.y += forces[id]!.y;
    }
  }
  return points;
}
