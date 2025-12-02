import { ChangeEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { GraphViewer } from '../src/GraphViewer.js';
import { migrate, type IonJSON, type Func, type MIRBlock, type SampleCounts } from '../src/iongraph.js';
import { assert } from '../src/utils.js';

export function renderWebUI(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<WebUI />);
}

export function renderStandaloneUI(root: HTMLElement, ionjson: {}) {
  const reactRoot = createRoot(root);
  const migrated = migrate(ionjson);
  reactRoot.render(<StandaloneUI ionjson={migrated} />);
}

const searchParams = new URL(window.location.toString()).searchParams;

const initialFuncIndex = searchParams.has("func") ? parseInt(searchParams.get("func")!, 10) : undefined;
const initialPass = searchParams.has("pass") ? parseInt(searchParams.get("pass")!, 10) : undefined;

interface MenuBarProps {
  browse?: boolean,
  export?: boolean,
  ionjson?: IonJSON,

  funcSelected: (func: Func | null) => void,
}

function MenuBar(props: MenuBarProps) {
  const [[ionjson, rawIonJSON], setIonJSON] = useState<readonly [IonJSON | null, string]>([null, ""]);
  const [funcIndex, setFuncIndex] = useState<number>(initialFuncIndex ?? 0);

  // One-time initializer
  useEffect(() => {
    if (props.ionjson) {
      setIonJSON([props.ionjson, JSON.stringify(props.ionjson)]);
      props.funcSelected(props.ionjson.functions[funcIndex] ?? null);
    }
  }, []);

  // Update ionjson if the prop changes.
  useEffect(() => {
    if (props.ionjson) {
      setIonJSON([props.ionjson, JSON.stringify(props.ionjson)]);
      props.funcSelected(props.ionjson.functions[funcIndex] ?? null);
    }
  }, [props.ionjson]);

  // Notify when the func index changes.
  useEffect(() => {
    if (ionjson) {
      props.funcSelected(ionjson.functions[funcIndex] ?? null);
    }
  }, [funcIndex]);

  async function fileSelected(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    if (!input.files?.length) {
      return;
    }

    const file = input.files[0];
    const newJSON = JSON.parse(await file.text());
    const migrated = migrate(newJSON);
    setIonJSON([migrated, JSON.stringify(migrated)]);
    setFuncIndex(0);
    props.funcSelected(migrated.functions[0] ?? null);
  }

  const numFunctions = ionjson?.functions.length ?? 0;
  const funcIndexValid = 0 <= funcIndex && funcIndex < numFunctions;

  return <div className="ig-bb ig-flex ig-bg-white">
    <div className="ig-pv2 ig-ph3 ig-flex ig-g2 ig-items-center ig-br">
      {props.browse && <div>
        <input type="file" onChange={fileSelected} />
      </div>}
      {numFunctions > 1 && <div>
        Function <input
          type="number"
          min="1"
          max={numFunctions}
          value={funcIndex + 1}
          className="ig-w3"
          onChange={e => {
            const displayValue = parseInt(e.target.value, 10);
            const newFuncIndex = Math.max(0, Math.min(numFunctions - 1, displayValue - 1));
            setFuncIndex(isNaN(newFuncIndex) ? 0 : newFuncIndex);
          }}
        /> / {numFunctions}
      </div>}
      {ionjson && numFunctions === 0 && <div>No functions to display.</div>}
    </div>
    <div className="ig-flex-grow-1 ig-pv2 ig-ph3 ig-flex ig-g2 ig-items-center">
      {funcIndexValid && <div>{ionjson?.functions[funcIndex].name ?? ""}</div>}
      <div className="ig-flex-grow-1"></div>
      {props.export && <div>
        <button
          disabled={!funcIndexValid}
          onClick={() => {
            exportStandalone(ionjson?.functions[funcIndex].name ?? "", rawIonJSON, { funcIndex: funcIndex });
          }}
        >Export</button>
      </div>}
    </div>
  </div>;
}

function WebUI() {
  const [initialIonJSON, setInitialIonJSON] = useState<IonJSON | undefined>();
  const [func, setFunc] = useState<Func | null>(null);
  const [sampleCounts, setSampleCounts] = useState<SampleCounts | undefined>();

  useEffect(() => {
    (async () => {
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

        setInitialIonJSON(migrated);
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

  return <div className="ig-absolute ig-absolute-fill ig-flex ig-flex-column">
    <MenuBar browse export ionjson={initialIonJSON} funcSelected={f => setFunc(f)} />
    {
      func && <div className="ig-relative ig-flex-basis-0 ig-flex-grow-1 ig-overflow-hidden">
        <GraphViewer
          func={func}
          pass={initialPass}
          sampleCounts={sampleCounts}
        />
      </div>
    }
  </div >;
}

interface StandaloneUIProps {
  ionjson: IonJSON,
}

function StandaloneUI(props: StandaloneUIProps) {
  const [func, setFunc] = useState<Func | null>(null);
  return <div className="ig-absolute ig-absolute-fill ig-flex ig-flex-column">
    <MenuBar ionjson={props.ionjson} funcSelected={f => setFunc(f)} />
    {
      func && <div className="ig-relative ig-flex-basis-0 ig-flex-grow-1 ig-overflow-hidden">
        <GraphViewer
          func={func}
          pass={initialPass}
        />
      </div>
    }
  </div>;
}

interface ExportOptions {
  funcIndex?: number,
}

async function exportStandalone(name: string, rawIonJSON: string, opts: ExportOptions = {}) {
  let jsonString = rawIonJSON;
  if (opts.funcIndex !== undefined) {
    // HACK: Because the iongraph code actually mutates the input ion JSON, we
    // can't just JSON.stringify it any more, so we have to take the raw JSON
    // from the start of the whole process, re-parse it, filter it, and then
    // generate new raw JSON to write to the file!
    const parsedIonJSON = JSON.parse(rawIonJSON);
    const func = parsedIonJSON.functions[opts.funcIndex];
    const filteredIonJSON: IonJSON = { version: 1, functions: [func] };
    jsonString = JSON.stringify(filteredIonJSON);
  }

  const template = await (await fetch("./standalone.html")).text();
  const output = template.replace(/\{\{\s*IONJSON\s*\}\}/, jsonString);
  const url = URL.createObjectURL(new Blob([output], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `iongraph-${name}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
