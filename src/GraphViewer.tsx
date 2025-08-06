import { useEffect, useRef } from "react";
import { Graph } from "./Graph";

import type { MIRBlock } from "./iongraph";

export function GraphViewer({ blocks }: {
  blocks: MIRBlock[],
}) {
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (container.current) {
      container.current.innerHTML = "";
      try {
        new Graph(container.current, blocks);
      } catch (e) {
        container.current.innerHTML = "An error occurred while laying out the graph. See console.";
        console.error(e);
      }
    }
  });

  return <div ref={container} style={{ position: "relative" }} />;
}
