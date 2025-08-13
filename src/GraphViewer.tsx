import { useEffect, useRef, useState } from "react";
import { Graph } from "./Graph";

import type { Func, MIRBlock, Pass } from "./iongraph";
import { classes } from "./classes";

const ZOOM_SENSITIVITY = 1.05;
const WHEEL_DELTA_SCALE = 0.01;
const MAX_ZOOM = 1;
const MIN_ZOOM = 0.25;

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

  const zoom = useRef(1);
  const tx = useRef(0);
  const ty = useRef(0);

  const lastX = useRef(0);
  const lastY = useRef(0);

  function updatePanAndZoom() {
    if (!container.current) {
      return;
    }
    container.current.style.transform = `translate(${tx.current}px, ${ty.current}px) scale(${zoom.current})`;
  }

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
  }, [func, passNumber]);

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
      className="ig-flex-grow-1 ig-overflow-hidden"
      style={{ position: "relative" }}
      onWheel={e => {
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.current * Math.pow(ZOOM_SENSITIVITY, -e.deltaY * WHEEL_DELTA_SCALE)));
        const zoomDelta = (newZoom / zoom.current) - 1;
        zoom.current = newZoom;

        const { x: gx, y: gy } = e.currentTarget.getBoundingClientRect();
        const mouseOffsetX = (e.clientX - gx) - tx.current;
        const mouseOffsetY = (e.clientY - gy) - ty.current;
        tx.current -= mouseOffsetX * zoomDelta;
        ty.current -= mouseOffsetY * zoomDelta;

        updatePanAndZoom();
      }}
      onPointerDown={e => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        lastX.current = e.clientX;
        lastY.current = e.clientY;
      }}
      onPointerMove={e => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
          return;
        }

        const dx = (e.clientX - lastX.current);
        const dy = (e.clientY - lastY.current);
        tx.current += dx;
        ty.current += dy;
        lastX.current = e.clientX;
        lastY.current = e.clientY;

        updatePanAndZoom();
      }}
      onPointerUp={e => {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      <div ref={container} style={{
        transformOrigin: "top left",
        transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
      }} />
    </div>
  </div>;
}
