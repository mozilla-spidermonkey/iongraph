import { useEffect, useRef, useState } from "react";
import { Graph } from "./Graph";

import type { Func, MIRBlock, Pass } from "./iongraph";

export function GraphViewer({ func, pass: propsPass = 0 }: {
  func: Func,
  pass?: number,
}) {
  const container = useRef<HTMLDivElement | null>(null);

  const [passNumber, setPassNumber] = useState(propsPass);

  // Update current pass if the parent passes one in.
  useEffect(() => {
    setPassNumber(propsPass);
  }, [propsPass]);

  useEffect(() => {
    const pass: Pass | undefined = func.passes[passNumber];

    if (container.current) {
      container.current.innerHTML = "";

      if (pass) {
        try {
          // TODO: Display LIR as well, or perhaps wrap that in the Graph
          // because they are interdependent.
          new Graph(container.current, pass.mir.blocks);
        } catch (e) {
          container.current.innerHTML = "An error occurred while laying out the graph. See console.";
          console.error(e);
        }
      }
    }
  });

  return <div className="ig-flex ig-w-100">
    <div className="ig-w5 ig-br ig-flex-shrink-0">
      {func.passes.map((pass, i) => <div key={i}>
        <a href="#" className="ig-link-normal ig-pv1 ig-ph2 ig-flex ig-g2" onClick={e => {
          e.preventDefault();
          setPassNumber(i);
        }}>
          <div
            className="ig-w1 ig-tr ig-f6 ig-text-dim"
            style={{ paddingTop: "0.08rem" }}
          >
            {i}
          </div>
          <div>{pass.name}</div>
        </a>
      </div>)}
    </div>
    <div ref={container} className="ig-flex-grow-1" style={{ position: "relative" }} />
  </div>;
}
