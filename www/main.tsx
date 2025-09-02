import { ChangeEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { GraphViewer } from '../src/GraphViewer.js';
import type { IonJSON, MIRBlock } from '../src/iongraph.js';

function TestViewer() {
  const searchParams = new URL(window.location.toString()).searchParams;

  const [ionjson, setIonJSON] = useState<IonJSON>({ functions: [] });

  useEffect(() => {
    const searchFile = searchParams.get("file");
    if (searchFile) {
      (async () => {
        const res = await fetch(searchFile);
        setIonJSON(await res.json());
      })();
    }
  }, []);

  const [func, setFunc] = useState(searchParams.has("func") ? parseInt(searchParams.get("func")!, 10) : 0);
  const [pass, setPass] = useState(searchParams.has("pass") ? parseInt(searchParams.get("pass")!, 10) : 0);
  const [block, setBlock] = useState<number | null>(searchParams.has("block") ? parseInt(searchParams.get("block")!, 10) : null);

  async function fileSelected(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    if (!input.files?.length) {
      setIonJSON({ functions: [] });
      return;
    }

    const file = input.files[0];
    const newJSON = JSON.parse(await file.text());
    setIonJSON(newJSON);
  }

  let blocks: MIRBlock[] = [];
  const funcValid = 0 <= func && func < ionjson.functions.length;
  const passes = funcValid ? ionjson.functions[func].passes : [];
  const passValid = 0 <= pass && pass < passes.length;
  if (funcValid && passValid) {
    blocks = passes[pass].mir.blocks;
  }

  return <div className="ig-absolute ig-absolute-fill ig-pa3 ig-flex ig-flex-column ig-g3">
    <div>
      <div><input type="file" onChange={fileSelected} /></div>
      {funcValid && passValid && <>
        <div>
          Function <input
            type="number"
            value={func}
            onChange={e => {
              const newFunc = parseInt(e.target.value, 10);
              if (0 <= newFunc && newFunc < ionjson.functions.length) {
                setFunc(newFunc);
              }
            }}
          />
          pass: <input
            type="number"
            value={pass}
            onChange={e => {
              const newPass = parseInt(e.target.value, 10);
              if (0 <= newPass && newPass < ionjson.functions[func].passes.length) {
                setPass(newPass);
              }
            }}
          />
        </div>
      </>}
    </div>
    {funcValid && passValid && <div className="ig-relative ig-ba ig-flex-basis-0 ig-flex-grow-1 ig-overflow-hidden">
      <GraphViewer func={ionjson.functions[func]} pass={pass} block={block} />
    </div>}
  </div>;
}

export function render(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<TestViewer />);
}
