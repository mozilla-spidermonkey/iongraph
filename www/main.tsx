import { ChangeEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { GraphViewer } from '../src/GraphViewer.js';
import { emptyIonJSON, migrate, type IonJSON, type MIRBlock, type SampleCounts } from '../src/iongraph.js';

export function render(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<TestViewer />);
}

function TestViewer() {
  const searchParams = new URL(window.location.toString()).searchParams;

  const [[ionjson, rawIonJSON], setIonJSON] = useState<readonly [IonJSON, string]>([emptyIonJSON, JSON.stringify(emptyIonJSON)]);
  const [sampleCounts, setSampleCounts] = useState<SampleCounts | undefined>();

  useEffect(() => {
    (async () => {
      //@ts-ignore
      if (window.__exportedIonJSON) {
        //@ts-ignore
        const migrated = migrate(window.__exportedIonJSON);
        setIonJSON([migrated, JSON.stringify(migrated)]);
      } else {
        const searchFile = searchParams.get("file");
        if (searchFile) {
          const res = await fetch(searchFile);
          const json = await res.json();

          // TODO: Remove this "functions" path for 1.0
          let migrated: IonJSON;
          if (json["functions"]) {
            migrated = migrate(json);
          } else {
            migrated = migrate({ functions: [json] });
          }

          setIonJSON([migrated, JSON.stringify(migrated)]);
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
      setIonJSON([emptyIonJSON, JSON.stringify(emptyIonJSON)]);
      return;
    }

    const file = input.files[0];
    const newJSON = JSON.parse(await file.text());
    const migrated = migrate(newJSON);
    setIonJSON([migrated, JSON.stringify(migrated)]);
  }

  let blocks: MIRBlock[] = [];
  const funcValid = 0 <= func && func < ionjson.functions.length;
  const passes = funcValid ? ionjson.functions[func].passes : [];
  const passValid = 0 <= pass && pass < passes.length;
  if (funcValid && passValid) {
    blocks = passes[pass].mir.blocks;
  }

  return <div className="ig-absolute ig-absolute-fill ig-flex ig-flex-column">
    <div className="ig-bb ig-pv2 ig-ph3 ig-flex ig-g2 ig-items-center ig-bg-white">
      <div>
        <input type="file" onChange={fileSelected} />
      </div>
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
        </div>
        <div>
          Pass: <input
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
        <div className="ig-flex-grow-1"></div>
        <div>
          <button onClick={() => exportStandalone(ionjson.functions[func].name, rawIonJSON)}>Export</button>
        </div>
      </>}
    </div>
    {
      funcValid && passValid && <div className="ig-relative ig-flex-basis-0 ig-flex-grow-1 ig-overflow-hidden">
        <GraphViewer
          func={ionjson.functions[func]}
          pass={pass}
          sampleCounts={sampleCounts}
        />
      </div>
    }
  </div >;
}

async function exportStandalone(name: string, rawIonJSON: string) {
  const template = await (await fetch("./standalone.html")).text();
  const output = template.replace(/\{\{\s*IONJSON\s*\}\}/, rawIonJSON);
  const url = URL.createObjectURL(new Blob([output], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `iongraph-${name}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  // setTimeout(() => URL.revokeObjectURL(url), 5000);
}
