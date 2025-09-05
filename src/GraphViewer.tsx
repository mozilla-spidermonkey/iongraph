import { useEffect, useRef, useState } from "react";

import { classes } from "./classes.js";
import { Graph } from "./Graph.js";
import type { BlockID, Func, Pass, SampleCounts } from "./iongraph.js";
import { must } from "./utils.js";

export interface GraphViewerProps {
  func: Func,
  pass?: number,

  sampleCounts?: SampleCounts,
}

type KeyPasses = [number | null, number | null, number | null, number | null];

export function GraphViewer({
  func,
  pass: propsPass = 0,

  sampleCounts
}: GraphViewerProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const graph = useRef<Graph | null>(null);

  const [passNumber, setPassNumber] = useState(propsPass);
  const [keyPasses, setKeyPasses] = useState<KeyPasses>([null, null, null, null]);

  // Update current pass if the parent passes one in.
  useEffect(() => {
    setPassNumber(propsPass);
  }, [propsPass]);

  useEffect(() => {
    const newKeyPasses: KeyPasses = [null, null, null, null];
    let lastPass: Pass | null = null;
    for (const [i, pass] of func.passes.entries()) {
      if (pass.mir.blocks.length > 0) {
        if (newKeyPasses[0] === null) {
          newKeyPasses[0] = i;
        }
        if (pass.lir.blocks.length === 0) {
          newKeyPasses[1] = i;
        }
      }
      if (pass.lir.blocks.length > 0) {
        if (lastPass?.lir.blocks.length === 0) {
          newKeyPasses[2] = i;
        }
        newKeyPasses[3] = i;
      }

      lastPass = pass;
    }

    setKeyPasses(newKeyPasses);
  }, [func]);

  function redrawGraph(pass: Pass | undefined) {
    if (viewport.current) {
      const currentTranslation = graph.current?.translation ?? { x: 0, y: 0 };
      const currentZoom = graph.current?.zoom ?? 1;

      const selected = graph.current?.selectedBlockIDs ?? new Set();
      const lastSelected = graph.current?.lastSelectedBlockID;
      let offsetX = 0, offsetY = 0;
      if (lastSelected !== undefined) {
        const block = must(must(graph.current).blocksByID.get(lastSelected));
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
            const newSelectedBlock = graph.current.blocksByID.get(lastSelected);
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

    const handler = () => {
      redrawGraph(pass);
    };
    window.addEventListener("tweak", handler);
    return () => {
      window.removeEventListener("tweak", handler);
    };
  }, [func, passNumber]);

  // Hook up keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "w":
        case "s": {
          graph.current?.navigate(e.key === "s" ? "down" : "up");
          graph.current?.jumpToBlock(graph.current?.lastSelectedBlockID ?? -1 as BlockID);
        } break;
        case "a":
        case "d": {
          graph.current?.navigate(e.key === "d" ? "right" : "left");
          graph.current?.jumpToBlock(graph.current?.lastSelectedBlockID ?? -1 as BlockID);
        } break;

        case "f": {
          setPassNumber(pn => Math.min(pn + 1, func.passes.length - 1));
        } break;
        case "r": {
          setPassNumber(pn => Math.max(pn - 1, 0));
        } break;
        case "1":
        case "2":
        case "3":
        case "4": {
          const keyPassIndex = ["1", "2", "3", "4"].indexOf(e.key);
          const keyPass = keyPasses[keyPassIndex];
          if (typeof keyPass === "number") {
            setPassNumber(keyPass);
          }
        } break;

        case "c": {
          const selected = graph.current?.blocksByID.get(graph.current?.lastSelectedBlockID ?? -1 as BlockID);
          if (selected && viewport.current) {
            graph.current?.jumpToBlock(selected.id, 1);
          }
        } break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    }
  }, [func, keyPasses]);

  return <div className="ig-absolute ig-absolute-fill ig-flex">
    <div className="ig-w5 ig-br ig-flex-shrink-0 ig-overflow-y-auto ig-bg-white">
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
