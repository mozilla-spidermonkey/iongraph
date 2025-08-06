import { createRoot } from 'react-dom/client';
import { GraphViewer } from './GraphViewer';
import { ChangeEvent, useState } from 'react';

import type { IonJSON, MIRBlock } from './iongraph';

function TestViewer() {
  const [ionjson, setIonJSON] = useState<IonJSON>({ functions: [] });

  const [func, setFunc] = useState(0);
  const [pass, setPass] = useState(0);

  async function fileSelected(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    if (!input.files?.length) {
      setIonJSON({ functions: [] });
      return;
    }

    const file = input.files[0];
    const newJSON = JSON.parse(await file.text());
    setIonJSON(newJSON);
    setFunc(0);
    setPass(0);
  }

  let blocks: MIRBlock[] = [];
  const funcValid = 0 <= func && func < ionjson.functions.length;
  const passes = funcValid ? ionjson.functions[func].passes : [];
  const passValid = 0 <= pass && pass < passes.length;
  if (funcValid && passValid) {
    blocks = passes[pass].mir.blocks;
  }

  return <div>
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
      <GraphViewer blocks={blocks} />
    </>}
  </div>;
}

export function render(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<TestViewer />);
}
