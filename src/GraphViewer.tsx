import { useEffect, useRef, useState } from "react";
import { Graph } from "./Graph";

import type { Func, MIRBlock, Pass } from "./iongraph";
import { classes } from "./classes";
import { clamp } from "./utils";

const ZOOM_SENSITIVITY = 1.10;
const WHEEL_DELTA_SCALE = 0.01;
const MAX_ZOOM = 1;
const MIN_ZOOM = 0.25;

const CLAMP_AMOUNT = 40;

export function GraphViewer({ func, pass: propsPass = 0 }: {
  func: Func,
  pass?: number,
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const graphDiv = useRef<HTMLDivElement | null>(null);
  const graph = useRef<Graph | null>(null);

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

  function clampTranslation(tx: number, ty: number, scale: number): [number, number] {
    if (!container.current || !graph.current) {
      return [tx, ty];
    }

    const containerRect = container.current.getBoundingClientRect();

    const minX = containerRect.x + CLAMP_AMOUNT - graph.current.width * scale;
    const maxX = containerRect.x + containerRect.width - CLAMP_AMOUNT;
    const minY = containerRect.y + CLAMP_AMOUNT - graph.current.height * scale;
    const maxY = containerRect.y + containerRect.height - CLAMP_AMOUNT;

    const x = containerRect.x + tx;
    const y = containerRect.y + ty;

    const newX = clamp(x, minX, maxX);
    const newY = clamp(y, minY, maxY);

    return [newX - containerRect.x, newY - containerRect.y];
  }

  function updatePanAndZoom() {
    if (!graphDiv.current) {
      return;
    }

    // We clamp here as well as in the input events because we want to respect
    // the clamped limits even when jumping from pass to pass. But then when we
    // actually receive input we want the clamping to "stick".
    const [clampedTx, clampedTy] = clampTranslation(tx.current, ty.current, zoom.current);
    graphDiv.current.style.transform = `translate(${clampedTx}px, ${clampedTy}px) scale(${zoom.current})`;
  }

  useEffect(() => {
    const pass: Pass | undefined = func.passes[passNumber];

    if (graphDiv.current) {
      graphDiv.current.innerHTML = "";
      graph.current = null;

      if (pass) {
        try {
          // TODO: Display LIR as well, or perhaps wrap that in the Graph
          // because they are interdependent.
          graph.current = new Graph(graphDiv.current, pass.mir.blocks);
        } catch (e) {
          graphDiv.current.innerHTML = "An error occurred while laying out the graph. See console.";
          console.error(e);
        }
      }
    }
  }, [func, passNumber]);

  useEffect(() => {
    updatePanAndZoom(); // make sure we do this on every React update
  });

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
      ref={container}
      className="ig-flex-grow-1 ig-overflow-hidden"
      style={{ position: "relative" }}
      onWheel={e => {
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.current * Math.pow(ZOOM_SENSITIVITY, -e.deltaY * WHEEL_DELTA_SCALE)));
        const zoomRatio = newZoom / zoom.current;
        const zoomDelta = zoomRatio - 1;
        zoom.current = newZoom;

        const { x: gx, y: gy } = e.currentTarget.getBoundingClientRect();
        const mouseOffsetX = (e.clientX - gx) - tx.current;
        const mouseOffsetY = (e.clientY - gy) - ty.current;
        tx.current -= mouseOffsetX * zoomDelta;
        ty.current -= mouseOffsetY * zoomDelta;

        const [clampedTx, clampedTy] = clampTranslation(tx.current, ty.current, zoomRatio);
        tx.current = clampedTx;
        ty.current = clampedTy;

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

        const [clampedTx, clampedTy] = clampTranslation(tx.current, ty.current, zoom.current);
        tx.current = clampedTx;
        ty.current = clampedTy;

        updatePanAndZoom();
      }}
      onPointerUp={e => {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      <div ref={graphDiv} style={{
        transformOrigin: "top left",
      }} />
    </div>
  </div>;
}
