import { useRef, useEffect } from "react";

import { GraphViewer } from "./GraphViewer.js";
import { Func, SampleCounts } from "./iongraph.js";

export interface GraphViewerReactProps {
  func: Func,
  pass?: number,
  sampleCounts?: SampleCounts,

  className?: string;
  style?: React.CSSProperties;
}

export function GraphViewerReact(props: GraphViewerReactProps) {
  const root = useRef<HTMLDivElement>(null);
  const graphViewer = useRef<GraphViewer | null>(null);

  useEffect(() => {
    if (graphViewer.current) {
      graphViewer.current.destroy();
      graphViewer.current = null;
    }
    if (root.current) {
      graphViewer.current = new GraphViewer(root.current, {
        func: props.func,
        pass: props.pass,

        sampleCounts: props.sampleCounts,
      });
    }

    return () => {
      graphViewer.current?.destroy();
    };
  }, [props.func, props.pass, props.sampleCounts]);

  return <div ref={root} className={props.className} style={props.style} />
};
