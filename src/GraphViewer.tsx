import { useEffect, useRef, useState } from "react";

import { classes } from "./classes.js";
import { Graph } from "./Graph.js";
import type { Func, Pass, SampleCounts } from "./iongraph.js";
import { must } from "./utils.js";

export interface GraphViewerProps {
  func: Func,
  pass?: number,
  block?: number | null,

  sampleCounts?: SampleCounts,
}

export function GraphViewer({
  func,
  pass: propsPass = 0,
  block: propsBlock = null,

  sampleCounts
}: GraphViewerProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const graph = useRef<Graph | null>(null);

  const [passNumber, setPassNumber] = useState(propsPass);

  // Update current pass if the parent passes one in.
  useEffect(() => {
    setPassNumber(propsPass);
  }, [propsPass]);

  function redrawGraph(pass: Pass | undefined) {
    if (viewport.current) {
      const currentTranslation = graph.current?.translation ?? { x: 0, y: 0 };
      const currentZoom = graph.current?.zoom ?? 1;

      const selected = graph.current?.selectedBlocks ?? new Set();
      const lastSelected = graph.current?.lastSelectedBlock;
      let offsetX = 0, offsetY = 0;
      if (lastSelected !== undefined) {
        const block = must(must(graph.current).blocksByNum.get(lastSelected));
        offsetX = block.layoutNode.pos.x - (-graph.current!.translation.x / graph.current!.zoom);
        offsetY = block.layoutNode.pos.y - (-graph.current!.translation.y / graph.current!.zoom);
      }

      viewport.current.innerHTML = "";
      graph.current = null;

      if (pass) {
        try {
          graph.current = new Graph(viewport.current, pass, {
            sampleCounts,
          });
          graph.current.setSelection([...selected], lastSelected);
          if (lastSelected !== undefined) {
            const newSelectedBlock = graph.current.blocksByNum.get(lastSelected);
            if (newSelectedBlock) { // The desired selected block still exists
              graph.current.goToCoordinates(
                {
                  x: newSelectedBlock.layoutNode.pos.x - offsetX,
                  y: newSelectedBlock.layoutNode.pos.y - offsetY,
                },
                currentZoom,
                false, // animate
              );
            }
          } else {
            graph.current.translation.x = currentTranslation.x;
            graph.current.translation.y = currentTranslation.y;
            graph.current.zoom = currentZoom;
            graph.current.updatePanAndZoom();
          }
        } catch (e) {
          viewport.current.innerHTML = "An error occurred while laying out the graph. See console.";
          console.error(e);
        }
      }
    }
  }

  // Redraw graph when the func or pass changes, and hook it up to the
  // tweak system.
  useEffect(() => {
    const pass: Pass | undefined = func.passes[passNumber];
    redrawGraph(pass);
    if (propsBlock !== null) {
      graph.current?.setSelection([], propsBlock);
      graph.current?.jumpToBlock(propsBlock);
    }

    const handler = () => {
      redrawGraph(pass);
    };
    window.addEventListener("tweak", handler);
    return () => {
      window.removeEventListener("tweak", handler);
    };
  }, [func, passNumber, propsBlock]);

  // Hook up keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "w":
        case "s": {
          graph.current?.navigate(e.key === "s" ? "down" : "up");
          graph.current?.jumpToBlock(graph.current?.lastSelectedBlock ?? -1);
        } break;
        case "a":
        case "d": {
          graph.current?.navigate(e.key === "d" ? "right" : "left");
          graph.current?.jumpToBlock(graph.current?.lastSelectedBlock ?? -1);
        } break;
        case "f": {
          setPassNumber(pn => Math.min(pn + 1, func.passes.length - 1));
        } break;
        case "r": {
          setPassNumber(pn => Math.max(pn - 1, 0));
        } break;
        case "c": {
          const selected = graph.current?.blocksByNum.get(graph.current?.lastSelectedBlock ?? -1);
          if (selected && viewport.current) {
            graph.current?.jumpToBlock(selected.number, 1);
          }
        } break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    }
  }, [func]);

  return <div className="ig-absolute ig-absolute-fill ig-flex">
    <div className="ig-w5 ig-br ig-flex-shrink-0 ig-overflow-y-auto">
      {func.passes.map((pass, i) => <div key={i}>
        <a
          href="#"
          className={classes(
            "ig-link-normal ig-pv1 ig-ph2 ig-flex ig-g2",
            { "ig-bg-primary": passNumber === i },
          )}
          onClick={e => {
            e.preventDefault();
            setPassNumber(i);
          }}
        >
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
    <div
      ref={viewport}
      className="ig-flex-grow-1 ig-overflow-hidden"
      style={{ position: "relative" }}
    />
  </div>;
}
