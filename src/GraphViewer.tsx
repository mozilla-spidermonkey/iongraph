import { useEffect, useRef, useState } from "react";
import { Graph } from "./Graph";
import { Func } from "./iongraph";

export function GraphViewer({ func }: {
  func: Func,
}) {
  const [pass, setPass] = useState(0);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (container.current) {
      container.current.innerHTML = "";
      new Graph(container.current, func.passes[pass].mir.blocks);
    }
  });

  return <div>
    <div>
      Function {func.name}, pass:
      <input
        type="number"
        value={pass}
        onChange={e => {
          const newPass = parseInt(e.target.value, 10);
          if (0 <= newPass && newPass < func.passes.length) {
            setPass(newPass);
          }
        }}
      />
    </div>
    <div ref={container} style={{ position: "relative" }} />
  </div>;
}
