import { useEffect, useRef, useState } from "react";
import { Graph } from "./Graph";

import type { Func, MIRBlock, Pass } from "./iongraph";
import { classes } from "./classes";
import { clamp, filerp } from "./utils";
import { tweak } from "./tweak";

const ZOOM_SENSITIVITY = 1.10;
const WHEEL_DELTA_SCALE = 0.01;
const MAX_ZOOM = 1;
const MIN_ZOOM = 0.10;

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
  const tx = useRef(0), ty = useRef(0);

  const animating = useRef(false);
  const targetZoom = useRef(1);
  const targetTx = useRef(0), targetTy = useRef(0);

  const startMouseX = useRef(0), startMouseY = useRef(0);
  const lastMouseX = useRef(0), lastMouseY = useRef(0);

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

  // Pans and zooms the graph such that the given x and y are in the top left
  // of the viewport at the requested zoom level.
  async function goToCoordinates(x: number, y: number, zm: number, animate = true) {
    const newTx = -x * zm;
    const newTy = -y * zm;

    if (!animate) {
      animating.current = false;
      tx.current = newTx;
      ty.current = newTy;
      zoom.current = zm;
      updatePanAndZoom();
      return;
    }

    targetTx.current = newTx;
    targetTy.current = newTy;
    targetZoom.current = zm;
    if (animating.current) {
      // Do not start another animation loop.
      return;
    }

    animating.current = true;
    let lastTime = performance.now();
    while (animating.current) {
      const now = await new Promise<number>(res => requestAnimationFrame(res));
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const THRESHOLD_T = 1, THRESHOLD_ZOOM = 0.01;
      const R = 0.000001; // fraction remaining after one second: smaller = faster
      const dx = targetTx.current - tx.current;
      const dy = targetTy.current - ty.current;
      const dzoom = targetZoom.current - zoom.current;
      tx.current = filerp(tx.current, targetTx.current, R, dt);
      ty.current = filerp(ty.current, targetTy.current, R, dt);
      zoom.current = filerp(zoom.current, targetZoom.current, R, dt);
      updatePanAndZoom();

      if (
        Math.abs(dx) <= THRESHOLD_T
        && Math.abs(dy) <= THRESHOLD_T
        && Math.abs(dzoom) <= THRESHOLD_ZOOM
      ) {
        tx.current = targetTx.current;
        ty.current = targetTy.current;
        zoom.current = targetZoom.current;
        animating.current = false;
        updatePanAndZoom();
        break;
      }
    }
  }

  function jumpToBlock(block: number, zm?: number, animate = true) {
    const z = zm ?? zoom.current;

    if (!container.current) {
      return;
    }

    const selected = graph.current?.blocksByNum.get(block);
    if (!selected) {
      return;
    }

    const containerRect = container.current.getBoundingClientRect();
    const viewportWidth = containerRect.width / z;
    const viewportHeight = containerRect.height / z;
    const xPadding = Math.max(20 / z, (viewportWidth - selected.layoutNode.size.x) / 2);
    const yPadding = Math.max(100 / z, (viewportHeight - selected.layoutNode.size.y) / 2);
    const x = selected.layoutNode.pos.x - xPadding;
    const y = selected.layoutNode.pos.y - yPadding;
    goToCoordinates(x, y, z, animate);
  }

  function redrawGraph(pass: Pass | undefined) {
    if (graphDiv.current) {
      graphDiv.current.innerHTML = "";
      graph.current = null;

      if (pass) {
        try {
          // TODO: Display LIR as well, or perhaps wrap that in the Graph
          // because they are interdependent.
          graph.current = new Graph(graphDiv.current, pass);
        } catch (e) {
          graphDiv.current.innerHTML = "An error occurred while laying out the graph. See console.";
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

  // Update pan and zoom on every React update
  useEffect(() => {
    updatePanAndZoom();
  });

  // Hook up keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "a":
        case "d": {
          if (!graph.current) {
            break;
          }

          const selected = graph.current.lastSelectedBlock;
          const blocks = graph.current.blocksInOrder;
          if (selected === undefined) {
            let block = blocks[e.key === "d" ? 0 : blocks.length - 1].number;
            graph.current.setSelection([], block);
          } else {
            const indexOfSelected = blocks.findIndex(b => b.number === selected);
            if (e.key === "a" && 1 <= indexOfSelected) {
              graph.current.setSelection([], blocks[indexOfSelected - 1].number);
            } else if (e.key === "d" && indexOfSelected <= graph.current.blocks.length - 2) {
              graph.current.setSelection([], blocks[indexOfSelected + 1].number);
            }
          }
          jumpToBlock(graph.current.lastSelectedBlock ?? -1);
        } break;
        case "f": {
          setPassNumber(pn => Math.min(pn + 1, func.passes.length - 1));
        } break;
        case "r": {
          setPassNumber(pn => Math.max(pn - 1, 0));
        } break;
        case "c": {
          const selected = graph.current?.blocksByNum.get(graph.current?.lastSelectedBlock ?? -1);
          if (selected && container.current) {
            jumpToBlock(selected.number, 1);
          }
        } break;
        case "b": {
          goToCoordinates(387, 558, zoom.current);
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

        animating.current = false;
        updatePanAndZoom();
      }}
      onPointerDown={e => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        startMouseX.current = e.clientX;
        startMouseY.current = e.clientY;
        lastMouseX.current = e.clientX;
        lastMouseY.current = e.clientY;
        animating.current = false;
      }}
      onPointerMove={e => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
          return;
        }

        const dx = (e.clientX - lastMouseX.current);
        const dy = (e.clientY - lastMouseY.current);
        tx.current += dx;
        ty.current += dy;
        lastMouseX.current = e.clientX;
        lastMouseY.current = e.clientY;

        const [clampedTx, clampedTy] = clampTranslation(tx.current, ty.current, zoom.current);
        tx.current = clampedTx;
        ty.current = clampedTy;

        animating.current = false;
        updatePanAndZoom();
      }}
      onPointerUp={e => {
        e.currentTarget.releasePointerCapture(e.pointerId);

        const THRESHOLD = 2;
        const deltaX = startMouseX.current - e.clientX;
        const deltaY = startMouseY.current - e.clientY;
        if (Math.abs(deltaX) <= THRESHOLD && Math.abs(deltaY) <= THRESHOLD) {
          graph.current?.setSelection([]);
        }

        animating.current = false;
      }}
    >
      <div ref={graphDiv} style={{
        transformOrigin: "top left",
      }} />
    </div>
  </div>;
}
