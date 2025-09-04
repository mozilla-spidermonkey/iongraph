export interface IonJSON {
  functions: Func[],
}

export interface Func {
  name: string,
  passes: Pass[],
}

export interface Pass {
  name: string,
  mir: {
    blocks: MIRBlock[],
  },
  lir: {
    blocks: LIRBlock[],
  },
}

export type BlockID = number & { readonly __brand: "BlockID" }
export type BlockNumber = number & { readonly __brand: "BlockNumber" }

export interface MIRBlock {
  id: BlockID,
  number: BlockNumber,
  loopDepth: number,
  attributes: string[], // TODO: Specific
  predecessors: BlockNumber[],
  successors: BlockNumber[],
  instructions: MIRInstruction[],
}

export interface LIRBlock {
  id: BlockID,
  number: BlockNumber,
  instructions: LIRInstruction[],
}

export interface LIRInstruction {
  id: number,
  opcode: string,
  defs: number[],
}

export interface MIRInstruction {
  id: number,
  opcode: string,
  attributes: string[], // TODO: Specific
  inputs: number[],
  uses: number[],
  memInputs: unknown[], // TODO
  type: string,
}

export interface LIRBlock { }

export interface SampleCounts {
  selfLineHits: Map<number, number>,
  totalLineHits: Map<number, number>,
}

export type MigratedIonJSON = IonJSON & { readonly __brand: "MigratedIonJSON" };
export type MigratedFunc = Func & { readonly __brand: "MigratedIonFunc" };

export function migrate(ionJSON: IonJSON): MigratedIonJSON {
  for (const f of ionJSON.functions) {
    migrateFunc(f);
  }

  return ionJSON as MigratedIonJSON;
}

export function migrateFunc(f: Func): MigratedFunc {
  for (const p of f.passes) {
    for (const b of p.mir.blocks) {
      // TODO: Remove for 1.0
      if (b.id === undefined) {
        b.id = b.number as any as BlockID;
      }
    }
    for (const b of p.lir.blocks) {
      // TODO: Remove for 1.0
      if (b.id === undefined) {
        b.id = b.number as any as BlockID;
      }
    }
  }

  return f as MigratedFunc;
}
