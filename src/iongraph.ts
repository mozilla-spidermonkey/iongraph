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

export interface MIRBlock {
  number: number,
  loopDepth: number,
  attributes: string[], // TODO: Specific
  predecessors: number[],
  successors: number[],
  instructions: MIRInstruction[],
}

export interface LIRBlock {
  number: number,
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