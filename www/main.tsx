import { ChangeEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { GraphViewer } from '../src/GraphViewer.js';
import { Func, migrate, MigratedIonJSON, type IonJSON, type MIRBlock, type SampleCounts } from '../src/iongraph.js';

function TestViewer() {
  const searchParams = new URL(window.location.toString()).searchParams;

  const [ionjson, setIonJSON] = useState<MigratedIonJSON>(migrate({ functions: [] }));
  const [sampleCounts, setSampleCounts] = useState<SampleCounts | undefined>();

  useEffect(() => {
    (async () => {
      const searchFile = searchParams.get("file");
      if (searchFile) {
        const res = await fetch(searchFile);
        const json = await res.json();

        // TODO: Remove this "functions" path for 1.0
        if (json["functions"]) {
          setIonJSON(migrate(json as IonJSON));
        } else {
          setIonJSON(migrate({ functions: [json as Func] }));
        }
      }
    })();

    (async () => {
      const sampleCountsFile = searchParams.get("sampleCounts");
      if (sampleCountsFile) {
        const res = await fetch(sampleCountsFile);
        const json = await res.json();
        setSampleCounts({
          selfLineHits: new Map(json["selfLineHits"]),
          totalLineHits: new Map(json["totalLineHits"]),
        });
      }
    })();
  }, []);

  const [func, setFunc] = useState(searchParams.has("func") ? parseInt(searchParams.get("func")!, 10) : 0);
  const [pass, setPass] = useState(searchParams.has("pass") ? parseInt(searchParams.get("pass")!, 10) : 0);

  async function fileSelected(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    if (!input.files?.length) {
      setIonJSON(migrate({ functions: [] }));
      return;
    }

    const file = input.files[0];
    const newJSON = JSON.parse(await file.text()) as IonJSON;
    setIonJSON(migrate(newJSON));
  }

  let blocks: MIRBlock[] = [];
  const funcValid = 0 <= func && func < ionjson.functions.length;
  const passes = funcValid ? ionjson.functions[func].passes : [];
  const passValid = 0 <= pass && pass < passes.length;
  if (funcValid && passValid) {
    blocks = passes[pass].mir.blocks;
  }

  return <div className="ig-absolute ig-absolute-fill ig-flex ig-flex-column">
    <div className="ig-bb ig-pv2 ig-ph3">
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
        <div>{ionjson.functions[func].name}</div>
      </>}
    </div>
    {funcValid && passValid && <div className="ig-relative ig-flex-basis-0 ig-flex-grow-1 ig-overflow-hidden">
      <GraphViewer
        func={ionjson.functions[func]}
        pass={pass}
        sampleCounts={sampleCounts}
      />
    </div>}
  </div>;
}

export function render(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<TestViewer />);
}
