import type { MIRBlock, LIRBlock, LIRInstruction, MIRInstruction, Pass, SampleCounts, BlockID, BlockPtr, InsPtr, InsID } from "./iongraph.js";
import { tweak } from "./tweak.js";
import { assert, clamp, filerp, must } from "./utils.js";

const DEBUG = tweak("Debug?", 0, { min: 0, max: 1 });

const CONTENT_PADDING = 20;
const BLOCK_GAP = 44;
const PORT_START = 16;
const PORT_SPACING = 60;
const ARROW_RADIUS = 12;
const TRACK_PADDING = 36;
const JOINT_SPACING = 16;
const HEADER_ARROW_PUSHDOWN = 16;

const LAYOUT_ITERATIONS = tweak("Layout Iterations", 2, { min: 0, max: 6 });
const NEARLY_STRAIGHT = tweak("Nearly Straight Threshold", 30, { min: 0, max: 200 });
const NEARLY_STRAIGHT_ITERATIONS = tweak("Nearly Straight Iterations", 8, { min: 0, max: 10 });
const STOP_AT_PASS = tweak("Stop At Pass", 30, { min: 0, max: 30 });

const ZOOM_SENSITIVITY = 1.50;
const WHEEL_DELTA_SCALE = 0.01;
const MAX_ZOOM = 1;
const MIN_ZOOM = 0.10;
const TRANSLATION_CLAMP_AMOUNT = 40;

export interface Vec2 {
  x: number,
  y: number,
}

type Block = MIRBlock & {
  // Properties added at runtime for this graph
  lir: LIRBlock | null,
  preds: Block[],
  succs: Block[],
  el: HTMLElement,
  size: Vec2,
  layer: number,
  loopID: BlockID,
  layoutNode: LayoutNode, // this is set partway through the process but trying to type it as such is absolutely not worth it
}

type LoopHeader = Block & {
  loopHeight: number,
  parentLoop: LoopHeader | null,
  outgoingEdges: Block[],
  backedge: Block,
}

function isTrueLH(block: Block): block is LoopHeader {
  return block.attributes.includes("loopheader");
}

function isLH(block: Block): block is LoopHeader {
  return (block as any).loopHeight !== undefined;
}

function asTrueLH(block: Block | undefined): LoopHeader {
  assert(block);
  if (isTrueLH(block)) {
    return block;
  }
  throw new Error(`Block ${block.id} is not a LoopHeader`);
}

function asLH(block: Block | undefined): LoopHeader {
  assert(block);
  if (isLH(block)) {
    return block as LoopHeader;
  }
  throw new Error(`Block ${block.id} is not a pseudo LoopHeader`);
}

type LayoutNode = BlockNode | DummyNode;

type LayoutNodeID = number & { readonly __brand: "LayoutNodeID" };

interface _LayoutNodeCommon {
  id: LayoutNodeID,
  pos: Vec2,
  size: Vec2,
  srcNodes: LayoutNode[],
  dstNodes: LayoutNode[],
  jointOffsets: number[],
  flags: NodeFlags,
}

type BlockNode = _LayoutNodeCommon & {
  block: Block,
};

type DummyNode = _LayoutNodeCommon & {
  block: null,
  dstBlock: Block,
};

type NodeFlags = number;
const LEFTMOST_DUMMY: NodeFlags = 1 << 0;
const RIGHTMOST_DUMMY: NodeFlags = 1 << 1;
const IMMINENT_BACKEDGE_DUMMY: NodeFlags = 1 << 2;

export const SC_TOTAL = 0;
export const SC_SELF = 1;

const log = new Proxy(console, {
  get(target, prop: keyof Console) {
    const field = target[prop];

    if (typeof field !== "function") { // catches undefined too
      return field;
    }
    return +DEBUG ? field.bind(target) : () => { };
  }
});

export interface GraphNavigation {
  /** Chain of blocks visited by navigating up and down */
  visited: BlockPtr[],

  /** Current index into {@link visited} */
  currentIndex: number,

  /** Current set of sibling blocks to navigate sideways */
  siblings: BlockPtr[],
}

export interface HighlightedInstruction {
  ptr: InsPtr,
  paletteColor: number,
}

export interface GraphState {
  translation: Graph["translation"],
  zoom: Graph["zoom"],
  heatmapMode: Graph["heatmapMode"],
  highlightedInstructions: Graph["highlightedInstructions"],
  selectedBlockPtrs: Graph["selectedBlockPtrs"],
  lastSelectedBlockPtr: Graph["lastSelectedBlockPtr"],

  viewportPosOfSelectedBlock: Vec2 | undefined,
}

export interface RestoreStateOpts {
  preserveSelectedBlockPosition?: boolean,
}

export interface GraphOptions {
  /**
   * Sample counts to display when viewing the LIR graph.
   */
  sampleCounts?: SampleCounts,

  /**
   * An array of CSS colors to use for highlighting instructions. You are
   * encouraged to use CSS variables here.
   */
  instructionPalette?: string[],
}

export class Graph {
  //
  // HTML elements
  //
  viewport: HTMLElement
  viewportSize: Vec2;
  graphContainer: HTMLElement;

  //
  // Core iongraph data
  //
  pass: Pass;
  blocks: Block[];
  blocksInOrder: Block[];
  blocksByID: Map<BlockID, Block>;
  blocksByPtr: Map<BlockPtr, Block>;
  insPtrsByID: Map<InsID, InsPtr>;
  insIDsByPtr: Map<InsPtr, InsID>;
  loops: LoopHeader[];

  sampleCounts: SampleCounts | undefined;
  maxSampleCounts: [number, number]; // [total, self]
  heatmapMode: number; // SC_TOTAL or SC_SELF

  //
  // Post-layout info
  //
  size: Vec2;
  numLayers: number;

  //
  // Pan and zoom
  //
  zoom: number;
  translation: Vec2;

  animating: boolean;
  targetZoom: number;
  targetTranslation: Readonly<Vec2>;

  startMousePos: Readonly<Vec2>;
  lastMousePos: Readonly<Vec2>;

  //
  // Block and instruction selection / navigation
  //
  selectedBlockPtrs: Set<BlockPtr>;
  lastSelectedBlockPtr: BlockPtr; // 0 is treated as a null value
  nav: GraphNavigation;

  highlightedInstructions: HighlightedInstruction[];
  instructionPalette: string[];

  constructor(viewport: HTMLElement, pass: Pass, options: GraphOptions = {}) {
    const blocks = pass.mir.blocks as Block[];

    this.viewport = viewport;
    const viewportRect = viewport.getBoundingClientRect();
    this.viewportSize = {
      x: viewportRect.width,
      y: viewportRect.height,
    };

    this.graphContainer = document.createElement("div");
    this.graphContainer.classList.add("ig-graph");
    this.graphContainer.style.transformOrigin = "top left";
    this.viewport.appendChild(this.graphContainer);

    this.pass = pass;
    this.blocks = blocks;
    this.blocksInOrder = [...blocks].sort((a, b) => a.id - b.id);
    this.blocksByID = new Map();
    this.blocksByPtr = new Map();
    this.insPtrsByID = new Map();
    this.insIDsByPtr = new Map();
    this.loops = []; // top-level loops; this basically forms the root of the loop tree

    this.sampleCounts = options.sampleCounts;
    this.maxSampleCounts = [0, 0];
    this.heatmapMode = SC_TOTAL;

    for (const [ins, count] of this.sampleCounts?.totalLineHits ?? []) {
      this.maxSampleCounts[SC_TOTAL] = Math.max(this.maxSampleCounts[SC_TOTAL], count);
    }
    for (const [ins, count] of this.sampleCounts?.selfLineHits ?? []) {
      this.maxSampleCounts[SC_SELF] = Math.max(this.maxSampleCounts[SC_SELF], count);
    }

    this.size = { x: 0, y: 0 };
    this.numLayers = 0;

    this.zoom = 1;
    this.translation = { x: 0, y: 0 };

    this.animating = false;
    this.targetZoom = 1;
    this.targetTranslation = { x: 0, y: 0 };

    this.startMousePos = { x: 0, y: 0 };
    this.lastMousePos = { x: 0, y: 0 };

    this.selectedBlockPtrs = new Set();
    this.lastSelectedBlockPtr = 0 as BlockPtr;
    this.nav = {
      visited: [],
      currentIndex: -1,
      siblings: [],
    };

    this.highlightedInstructions = [];
    this.instructionPalette = options.instructionPalette ?? [0, 1, 2, 3, 4].map(n => `var(--ig-highlight-${n})`);

    const lirBlocks = new Map<BlockID, LIRBlock>();
    for (const lir of pass.lir.blocks) {
      lirBlocks.set(lir.id, lir);
    }

    // Initialize blocks
    for (const block of blocks) {
      assert(block.ptr, "blocks must always have non-null ptrs");

      this.blocksByID.set(block.id, block);
      this.blocksByPtr.set(block.ptr, block);
      for (const ins of block.instructions) {
        this.insPtrsByID.set(ins.id, ins.ptr);
        this.insIDsByPtr.set(ins.ptr, ins.id);
      }

      block.lir = lirBlocks.get(block.id) ?? null;
      if (block.lir) {
        for (const ins of block.lir.instructions) {
          // TODO: This is kind of jank because it will overwrite MIR
          // instructions that were also there. But we never render those, so
          // it's basically moot.
          this.insPtrsByID.set(ins.id, ins.ptr);
          this.insIDsByPtr.set(ins.ptr, ins.id);
        }
      }

      const el = this.renderBlock(block);
      block.el = el;

      block.layer = -1;
      block.loopID = -1 as BlockID;
      if (block.attributes.includes("loopheader")) {
        const lh = block as LoopHeader;
        lh.loopHeight = 0;
        lh.parentLoop = null;
        lh.outgoingEdges = [];
      }
    }

    // Compute sizes for all blocks. We do this after rendering all blocks so
    // that layout isn't constantly invalidated by adding new blocks.
    //
    // (Although, it's super bullshit that we have to do this, because all of
    // the blocks are absolutely positioned and therefore have zero impact on
    // any others. Adding another block to the page should not invalidate all
    // the layout properties of all the others! We should not see an 85%
    // speedup just from moving this out of the first loop, but we do!)
    for (const block of blocks) {
      block.size = {
        x: block.el.clientWidth,
        y: block.el.clientHeight,
      };
    }

    // After putting all blocks in our map, fill out block-to-block references.
    for (const block of blocks) {
      block.preds = block.predecessors.map(id => must(this.blocksByID.get(id)));
      block.succs = block.successors.map(id => must(this.blocksByID.get(id)));

      if (isTrueLH(block)) {
        const backedges = block.preds.filter(b => b.attributes.includes("backedge"));
        assert(backedges.length === 1);
        block.backedge = backedges[0];
      }
    }

    const [nodesByLayer, layerHeights, trackHeights] = this.layout();
    this.render(nodesByLayer, layerHeights, trackHeights);

    this.addEventListeners();
  }

  private layout(): [LayoutNode[][], number[], number[]] {
    const [roots, osrBlocks] = this.findLayoutRoots();
    log.log("Layout roots:", roots.map(r => r.id));

    // Make the roots and OSR blocks into pseudo loop headers.
    for (const b of [...roots, ...osrBlocks]) {
      const root = b as LoopHeader;
      root.loopHeight = 0;
      root.parentLoop = null;
      root.outgoingEdges = [];
      Object.defineProperty(root, "backedge", {
        get() {
          throw new Error("Accessed .backedge on a pseudo loop header! Don't do that.");
        },
        configurable: true,
      });
    }

    for (const r of roots) {
      log.group("findLoops");
      this.findLoops(r);
      log.groupEnd();
    }
    for (const r of roots) {
      log.group("layer");
      this.layer(r);
      log.groupEnd();
    }
    for (const b of osrBlocks) {
      b.layer = 0;
      b.loopID = b.id;
    }

    const layoutNodesByLayer = this.makeLayoutNodes();
    this.straightenEdges(layoutNodesByLayer);
    const trackHeights = this.finagleJoints(layoutNodesByLayer);
    const layerHeights = this.verticalize(layoutNodesByLayer, trackHeights);

    return [layoutNodesByLayer, layerHeights, trackHeights];
  }

  // Finds the "layout roots" of the graph, which are the blocks we should
  // start the layout process from. This may not always equal the true roots
  // (blocks without predecessors), because OSR blocks can cause us to begin
  // layout at arbitrary points in the graph.
  private findLayoutRoots(): [Block[], Block[]] {
    const newRoots: Block[] = [];
    const osrBlocks: Block[] = [];
    const roots = this.blocks.filter(b => b.predecessors.length === 0);
    for (const root of roots) {
      let newRoot = root;
      if (root.attributes.includes("osr")) {
        assert(root.succs.length > 0);

        // Walk up the graph by repeatedly choosing the first non-OSR, non-
        // backedge predecessor.

        const postOSR = root.succs[0];
        newRoot = postOSR;
        for (let j = 0; ; j++) {
          if (j >= 10_000_000) {
            throw new Error("likely infinite loop");
          }

          const validPredecessors = newRoot.preds.filter(p => !p.attributes.includes("osr") && !p.attributes.includes("backedge"));
          if (validPredecessors.length === 0) {
            break;
          }
          newRoot = validPredecessors[0];
        }

        // Did we actually end up at a new block? If so, track it, otherwise
        // just treat the OSR block as a normal root.
        if (newRoot !== postOSR) {
          osrBlocks.push(root);
        } else {
          newRoot = root;
        }
      }

      // Track and deduplicate
      if (!newRoots.includes(newRoot)) {
        newRoots.push(newRoot);
      }
    }
    return [newRoots, osrBlocks];
  }

  // Walks through the graph tracking which loop each block belongs to. As
  // each block is visited, it is assigned the current loop ID. If the
  // block has lesser loopDepth than its parent, that means it is outside
  // at least one loop, and the loop it belongs to can be looked up by loop
  // depth.
  private findLoops(block: Block, loopIDsByDepth: BlockID[] | null = null) {
    if (loopIDsByDepth === null) {
      loopIDsByDepth = [block.id];
    }

    // Early out if we already have a loop ID.
    if (block.loopID >= 0) {
      return;
    }

    log.log("block:", block.id, block.loopDepth, "loopIDsByDepth:", loopIDsByDepth);
    log.log(block.attributes);

    if (isTrueLH(block)) {
      const parentID = loopIDsByDepth[loopIDsByDepth.length - 1];
      const parent = asLH(this.blocksByID.get(parentID));
      block.parentLoop = parent;

      loopIDsByDepth = [...loopIDsByDepth, block.id];
      log.log("Block", block.id, "is true loop header, loopIDsByDepth is now", loopIDsByDepth);
    }

    if (block.loopDepth > loopIDsByDepth.length - 1) {
      // Sometimes the MIR optimization process can turn loop headers into
      // normal blocks, which means we have blocks that spuriously increase in
      // loop depth. Or perhaps we have an OSR entry that jumps straight into
      // the function at some point. In both cases we will see a higher loop
      // depth than we would think possible, but in each case it is ok to just
      // force the block back to a lesser loop depth.
      block.loopDepth = loopIDsByDepth.length - 1;
      log.log("Block", block.id, "has been forced back to loop depth", block.loopDepth);
    }

    if (block.loopDepth < loopIDsByDepth.length - 1) {
      loopIDsByDepth = loopIDsByDepth.slice(0, block.loopDepth + 1);
      log.log("Block", block.id, "has low loop depth, therefore we exited a loop. loopIDsByDepth:", loopIDsByDepth);
    }
    block.loopID = loopIDsByDepth[block.loopDepth];

    if (!block.attributes.includes("backedge")) {
      for (const succ of block.succs) {
        this.findLoops(succ, loopIDsByDepth);
      }
    }
  }

  private layer(block: Block, layer = 0) {
    log.log("block", block.id, "layer", layer);

    if (block.attributes.includes("backedge")) {
      block.layer = block.succs[0].layer;
      return;
    }

    if (layer <= block.layer) {
      return;
    }

    block.layer = Math.max(block.layer, layer);
    this.numLayers = Math.max(block.layer + 1, this.numLayers);

    let loopHeader: LoopHeader | null = asLH(this.blocksByID.get(block.loopID));
    while (loopHeader) {
      loopHeader.loopHeight = Math.max(loopHeader.loopHeight, block.layer - loopHeader.layer + 1);
      loopHeader = loopHeader.parentLoop;
    }

    for (const succ of block.succs) {
      if (succ.loopDepth < block.loopDepth) {
        // This is an outgoing edge from the current loop.
        // Track it on our current loop's header to be layered later.
        const loopHeader = asLH(this.blocksByID.get(block.loopID));
        loopHeader.outgoingEdges.push(succ);
      } else {
        this.layer(succ, layer + 1);
      }
    }

    if (isTrueLH(block)) {
      for (const succ of block.outgoingEdges) {
        this.layer(succ, layer + block.loopHeight);
      }
    }
  }

  private makeLayoutNodes(): LayoutNode[][] {
    log.group("makeLayoutNodes");

    function connectNodes(from: LayoutNode, fromPort: number, to: LayoutNode) {
      from.dstNodes[fromPort] = to;
      if (!to.srcNodes.includes(from)) {
        to.srcNodes.push(from);
      }
      log.log("connected", from.id, "to", to.id);
    }

    let blocksByLayer: Block[][];
    {
      const blocksByLayerObj: { [layer: number]: Block[] } = {};
      for (const block of this.blocks) {
        if (!blocksByLayerObj[block.layer]) {
          blocksByLayerObj[block.layer] = [];
        }
        blocksByLayerObj[block.layer].push(block);
      }
      blocksByLayer = Object.entries(blocksByLayerObj)
        .map(([layer, blocks]) => [Number(layer), blocks] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([_, blocks]) => blocks);
    }

    type IncompleteEdge = {
      src: LayoutNode,
      srcPort: number,
      dstBlock: Block,
    };

    let nodeID = 0 as LayoutNodeID;

    const layoutNodesByLayer: LayoutNode[][] = blocksByLayer.map(() => []);
    const activeEdges: IncompleteEdge[] = [];
    const latestDummiesForBackedges = new Map<Block, DummyNode>();
    for (const [layer, blocks] of blocksByLayer.entries()) {
      log.group("layer", layer, "blocks", blocks.map(b => b.id));

      // Delete any active edges that terminate at this layer, since we do
      // not want to make any dummy nodes for them.
      const terminatingEdges: IncompleteEdge[] = [];
      for (const block of blocks) {
        for (let i = activeEdges.length - 1; i >= 0; i--) {
          const edge = activeEdges[i];
          if (edge.dstBlock === block) {
            terminatingEdges.unshift(edge);
            activeEdges.splice(i, 1);
          }
        }
      }

      // Create dummy nodes for active edges, coalescing all edges with the same final destination.
      const dummiesByDest: Map<number, DummyNode> = new Map();
      for (const edge of activeEdges) {
        let dummy: DummyNode;

        const existingDummy = dummiesByDest.get(edge.dstBlock.id)
        if (existingDummy) {
          // Collapse multiple edges into a single dummy node.
          connectNodes(edge.src, edge.srcPort, existingDummy);
          dummy = existingDummy;
        } else {
          // Create a new dummy node.
          const newDummy: DummyNode = {
            id: nodeID++ as LayoutNodeID,
            pos: { x: CONTENT_PADDING, y: CONTENT_PADDING },
            size: { x: 0, y: 0 },
            block: null,
            srcNodes: [],
            dstNodes: [],
            dstBlock: edge.dstBlock,
            jointOffsets: [],
            flags: 0,
          };
          connectNodes(edge.src, edge.srcPort, newDummy);
          layoutNodesByLayer[layer].push(newDummy);
          dummiesByDest.set(edge.dstBlock.id, newDummy);
          dummy = newDummy;
          log.log("Created dummy", dummy.id, "on the way to block", edge.dstBlock.id);
        }

        // Update the active edge with the latest dummy.
        edge.src = dummy;
        edge.srcPort = 0;
      }

      // Track which blocks will get backedge dummy nodes.
      interface PendingLoopDummy {
        loopID: BlockID,
        block: Block,
      }
      const pendingLoopDummies: PendingLoopDummy[] = [];
      for (const block of blocks) {
        let currentLoopHeader = asLH(this.blocksByID.get(block.loopID));
        while (isTrueLH(currentLoopHeader)) {
          const existing = pendingLoopDummies.find(d => d.loopID === currentLoopHeader.id);
          if (existing) {
            // We have seen this loop before but have a new rightmost block for
            // it. Update which block should get the dummy.
            existing.block = block;
          } else {
            // This loop has not been seen before, so track it.
            pendingLoopDummies.push({ loopID: currentLoopHeader.id, block: block });
          }

          const parentLoop = currentLoopHeader.parentLoop;
          if (!parentLoop) {
            break;
          }
          currentLoopHeader = parentLoop;
        }
      }

      // Create real nodes for each block on the layer.
      const backedgeEdges: IncompleteEdge[] = [];
      for (const block of blocks) {
        // Create new layout node for block
        const node: BlockNode = {
          id: nodeID++ as LayoutNodeID,
          pos: { x: CONTENT_PADDING, y: CONTENT_PADDING },
          size: block.size,
          block: block,
          srcNodes: [],
          dstNodes: [],
          jointOffsets: [],
          flags: 0,
        };
        for (const edge of terminatingEdges) {
          if (edge.dstBlock === block) {
            connectNodes(edge.src, edge.srcPort, node);
          }
        }
        layoutNodesByLayer[layer].push(node);
        block.layoutNode = node;

        // Create dummy nodes for backedges
        for (const loopDummy of pendingLoopDummies.filter(d => d.block === block)) {
          const backedge = asLH(this.blocksByID.get(loopDummy.loopID)).backedge;
          const backedgeDummy: DummyNode = {
            id: nodeID++ as LayoutNodeID,
            pos: { x: CONTENT_PADDING, y: CONTENT_PADDING },
            size: { x: 0, y: 0 },
            block: null,
            srcNodes: [],
            dstNodes: [],
            dstBlock: backedge,
            jointOffsets: [],
            flags: 0,
          };

          const latestDummy = latestDummiesForBackedges.get(backedge);
          if (latestDummy) {
            connectNodes(backedgeDummy, 0, latestDummy);
          } else {
            backedgeDummy.flags |= IMMINENT_BACKEDGE_DUMMY;
            connectNodes(backedgeDummy, 0, backedge.layoutNode);
          }
          layoutNodesByLayer[layer].push(backedgeDummy);
          latestDummiesForBackedges.set(backedge, backedgeDummy);
        }

        if (block.attributes.includes("backedge")) {
          // Connect backedge to loop header immediately
          connectNodes(block.layoutNode, 0, block.succs[0].layoutNode);
        } else {
          for (const [i, succ] of block.succs.entries()) {
            if (succ.attributes.includes("backedge")) {
              // Track this edge to be added after all the backedge dummies on
              // this row have been added.
              backedgeEdges.push({ src: node, srcPort: i, dstBlock: succ });
            } else {
              activeEdges.push({ src: node, srcPort: i, dstBlock: succ });
            }
          }
        }
      }
      for (const edge of backedgeEdges) {
        const backedgeDummy = must(latestDummiesForBackedges.get(edge.dstBlock));
        connectNodes(edge.src, edge.srcPort, backedgeDummy);
      }

      log.groupEnd();
    }

    // Prune backedge dummies that don't have a source. This can happen because
    // we always generate dummy nodes at each level for active loops, but if a
    // loop doesn't branch back at the end, several dummy nodes will be left
    // orphaned.
    log.log("Pruning backedge dummies");
    {
      const orphanRoots: DummyNode[] = [];
      for (const dummy of backedgeDummies(layoutNodesByLayer)) {
        if (dummy.srcNodes.length === 0) {
          orphanRoots.push(dummy);
        }
      }

      const removedNodes = new Set<LayoutNode>();
      for (const orphan of orphanRoots) {
        let current: LayoutNode = orphan;
        while (current.block === null && current.srcNodes.length === 0) {
          pruneNode(current);
          removedNodes.add(current);
          assert(current.dstNodes.length === 1);
          current = current.dstNodes[0];
        }
      }
      for (const nodes of layoutNodesByLayer) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (removedNodes.has(nodes[i])) {
            nodes.splice(i, 1);
          }
        }
      }
    }

    // Mark leftmost and rightmost dummies.
    log.log("Marking leftmost and rightmost dummies");
    for (const nodes of layoutNodesByLayer) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].block === null) {
          nodes[i].flags |= LEFTMOST_DUMMY;
        } else {
          break;
        }
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].block === null) {
          nodes[i].flags |= RIGHTMOST_DUMMY;
        } else {
          break;
        }
      }
    }

    // Ensure that our nodes are all ok
    log.log("Verifying integrity of all nodes");
    for (const layer of layoutNodesByLayer) {
      for (const node of layer) {
        if (node.block) {
          assert(node.dstNodes.length === node.block.successors.length, `expected node ${node.id} for block ${node.block.id} to have ${node.block.successors.length} destination nodes, but got ${node.dstNodes.length} instead`);
        } else {
          assert(node.dstNodes.length === 1, `expected dummy node ${node.id} to have only one destination node, but got ${node.dstNodes.length} instead`);
        }
        for (let i = 0; i < node.dstNodes.length; i++) {
          assert(node.dstNodes[i] !== undefined, `dst slot ${i} of node ${node.id} was undefined`);
        }
      }
    }

    log.groupEnd();
    return layoutNodesByLayer;
  }

  private straightenEdges(layoutNodesByLayer: LayoutNode[][]) {
    // Push nodes to the right if they are too close together.
    const pushNeighbors = (nodes: LayoutNode[]) => {
      for (let i = 0; i < nodes.length - 1; i++) {
        const node = nodes[i];
        const neighbor = nodes[i + 1];

        const firstNonDummy = node.block === null && neighbor.block !== null;
        const nodeRightPlusPadding = node.pos.x + node.size.x + (firstNonDummy ? PORT_START : 0) + BLOCK_GAP;
        neighbor.pos.x = Math.max(neighbor.pos.x, nodeRightPlusPadding);
      }
    };

    // Push nodes to the right so they fit inside their loop.
    const pushIntoLoops = () => {
      for (const nodes of layoutNodesByLayer) {
        for (const node of nodes) {
          if (node.block === null) {
            continue;
          }

          const loopHeader = node.block.loopID !== null ? asLH(this.blocksByID.get(node.block.loopID)) : null;
          if (loopHeader) {
            const loopHeaderNode = loopHeader.layoutNode;
            node.pos.x = Math.max(node.pos.x, loopHeaderNode.pos.x);
          }
        }
      }
    };

    const straightenDummyRuns = () => {
      // Track max position of dummies
      const dummyLinePositions = new Map<Block, number>();
      for (const dummy of dummies(layoutNodesByLayer)) {
        const dst = dummy.dstBlock;
        let desiredX = dummy.pos.x;
        dummyLinePositions.set(dst, Math.max(dummyLinePositions.get(dst) ?? 0, desiredX));
      }

      // Apply positions to dummies
      for (const dummy of dummies(layoutNodesByLayer)) {
        const backedge = dummy.dstBlock;
        const x = dummyLinePositions.get(backedge);
        assert(x, `no position for backedge ${backedge.id}`);
        dummy.pos.x = x;
      }

      for (const nodes of layoutNodesByLayer) {
        pushNeighbors(nodes);
      }
    };

    const suckInLeftmostDummies = () => {
      // Break leftmost dummy runs by pulling them as far right as possible
      // (but never pulling any node to the right of its parent, or its
      // ultimate destination block). Track the min position for each
      // destination as we go.
      const dummyRunPositions = new Map<Block, number>();
      for (const nodes of layoutNodesByLayer) {
        // Find leftmost non-dummy node
        let i = 0;
        let nextX = 0;
        for (; i < nodes.length; i++) {
          if (!(nodes[i].flags & LEFTMOST_DUMMY)) {
            nextX = nodes[i].pos.x;
            break;
          }
        }

        // Walk backward through leftmost dummies, calculating how far to the
        // right we can push them.
        i -= 1;
        nextX -= BLOCK_GAP + PORT_START;
        for (; i >= 0; i--) {
          const dummy = nodes[i] as DummyNode;
          assert(dummy.block === null && dummy.flags & LEFTMOST_DUMMY);
          let maxSafeX = nextX;
          // Don't let dummies go to the right of their source nodes.
          for (const src of dummy.srcNodes) {
            const srcX = src.pos.x + src.dstNodes.indexOf(dummy) * PORT_SPACING;
            if (srcX < maxSafeX) {
              maxSafeX = srcX;
            }
          }
          dummy.pos.x = maxSafeX;
          nextX = dummy.pos.x - BLOCK_GAP;
          dummyRunPositions.set(dummy.dstBlock, Math.min(dummyRunPositions.get(dummy.dstBlock) ?? Infinity, maxSafeX));
        }
      }

      // Apply min positions to all dummies in a run.
      for (const dummy of dummies(layoutNodesByLayer)) {
        if (!(dummy.flags & LEFTMOST_DUMMY)) {
          continue;
        }
        const x = dummyRunPositions.get(dummy.dstBlock);
        assert(x, `no position for run to block ${dummy.dstBlock.id}`);
        dummy.pos.x = x;
      }
    };

    // Walk down the layers, pulling children to the right to line up with
    // their parents.
    const straightenChildren = () => {
      for (let layer = 0; layer < layoutNodesByLayer.length - 1; layer++) {
        const nodes = layoutNodesByLayer[layer];

        pushNeighbors(nodes);

        // If a node has been shifted, we must never shift any node to its
        // left. This preserves stable graph layout and just avoids lots of
        // jank. We also only shift a child based on its first parent, because
        // otherwide nodes end up being pulled too far to the right.
        let lastShifted = -1;
        for (const node of nodes) {
          for (const [srcPort, dst] of node.dstNodes.entries()) {
            let dstIndexInNextLayer = layoutNodesByLayer[layer + 1].indexOf(dst);
            if (dstIndexInNextLayer > lastShifted && dst.srcNodes[0] === node) {
              const srcPortOffset = PORT_START + PORT_SPACING * srcPort;
              const dstPortOffset = PORT_START;

              let xBefore = dst.pos.x;
              dst.pos.x = Math.max(dst.pos.x, node.pos.x + srcPortOffset - dstPortOffset);
              if (dst.pos.x !== xBefore) {
                lastShifted = dstIndexInNextLayer;
              }
            }
          }
        }
      }
    };

    // Walk each layer right to left, pulling nodes to the right to line them
    // up with their parents and children as well as possible, but WITHOUT ever
    // causing another overlap and therefore any need to push neighbors.
    //
    // (The exception is rightmost dummies; we push those because we can
    // trivially straighten them later.)
    const straightenConservative = () => {
      for (const nodes of layoutNodesByLayer) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];

          // Only do this to block nodes, and not to backedges.
          if (!node.block || node.block.attributes.includes("backedge")) {
            continue;
          }

          let deltasToTry: number[] = [];
          for (const parent of node.srcNodes) {
            const srcPortOffset = PORT_START + parent.dstNodes.indexOf(node) * PORT_SPACING;
            const dstPortOffset = PORT_START;
            deltasToTry.push((parent.pos.x + srcPortOffset) - (node.pos.x + dstPortOffset));
          }
          for (const [srcPort, dst] of node.dstNodes.entries()) {
            if (dst.block === null && dst.dstBlock.attributes.includes("backedge")) {
              continue;
            }
            const srcPortOffset = PORT_START + srcPort * PORT_SPACING;
            const dstPortOffset = PORT_START;
            deltasToTry.push((dst.pos.x + dstPortOffset) - (node.pos.x + srcPortOffset));
          }
          if (deltasToTry.includes(0)) {
            // Already aligned with something! Ignore this and move on.
            continue;
          }
          deltasToTry = deltasToTry
            .filter(d => d > 0)
            .sort((a, b) => a - b);

          for (const delta of deltasToTry) {
            let overlapsAny = false;
            for (let j = i + 1; j < nodes.length; j++) {
              const other = nodes[j];
              if (other.flags & RIGHTMOST_DUMMY) {
                // Ignore rightmost dummies since they can be freely straightened out later.
                continue;
              }
              const a1 = node.pos.x + delta, a2 = node.pos.x + delta + node.size.x;
              const b1 = other.pos.x - BLOCK_GAP, b2 = other.pos.x + other.size.x + BLOCK_GAP;
              const overlaps = a2 >= b1 && a1 <= b2;
              if (overlaps) {
                overlapsAny = true;
              }
            }
            if (!overlapsAny) {
              node.pos.x += delta;
              break;
            }
          }
        }

        pushNeighbors(nodes);
      }
    };

    // Walk up the layers, straightening out edges that are nearly straight.
    const straightenNearlyStraightEdgesUp = () => {
      for (let layer = layoutNodesByLayer.length - 1; layer >= 0; layer--) {
        const nodes = layoutNodesByLayer[layer];

        pushNeighbors(nodes);

        for (const node of nodes) {
          for (const src of node.srcNodes) {
            if (src.block !== null) {
              // Only do this to dummies, because straightenChildren takes care
              // of block-to-block edges.
              continue;
            }

            const wiggle = Math.abs(src.pos.x - node.pos.x);
            if (wiggle <= NEARLY_STRAIGHT) {
              src.pos.x = Math.max(src.pos.x, node.pos.x);
              node.pos.x = Math.max(src.pos.x, node.pos.x);
            }
          }
        }
      }
    };

    // Ditto, but walking down instead of up.
    const straightenNearlyStraightEdgesDown = () => {
      for (let layer = 0; layer < layoutNodesByLayer.length; layer++) {
        const nodes = layoutNodesByLayer[layer];

        pushNeighbors(nodes);

        for (const node of nodes) {
          if (node.dstNodes.length === 0) {
            continue;
          }
          const dst = node.dstNodes[0];
          if (dst.block !== null) {
            // Only do this to dummies for the reasons above.
            continue;
          }

          const wiggle = Math.abs(dst.pos.x - node.pos.x);
          if (wiggle <= NEARLY_STRAIGHT) {
            dst.pos.x = Math.max(dst.pos.x, node.pos.x);
            node.pos.x = Math.max(dst.pos.x, node.pos.x);
          }
        }
      }
    };

    function repeat<T>(a: T[], n: number): T[] {
      const result: T[] = [];
      for (let i = 0; i < n; i++) {
        for (const item of a) {
          result.push(item);
        }
      }
      return result;
    }

    // The order of these passes is arbitrary. I just play with it until I like
    // the result. I have them in this wacky structure because I want to be
    // able to use my debug scrubber.
    const passes = [
      ...repeat([
        straightenChildren,
        pushIntoLoops,
        straightenDummyRuns,
      ], LAYOUT_ITERATIONS),
      straightenDummyRuns,
      ...repeat([
        straightenNearlyStraightEdgesUp,
        straightenNearlyStraightEdgesDown,
      ], NEARLY_STRAIGHT_ITERATIONS),
      straightenConservative,
      straightenDummyRuns,
      suckInLeftmostDummies,
    ];
    assert(passes.length <= (STOP_AT_PASS.initial ?? Infinity), `STOP_AT_PASS was too small - should be at least ${passes.length}`);
    log.group("Running passes");
    for (const [i, pass] of passes.entries()) {
      if (i < STOP_AT_PASS) {
        log.log(pass.name ?? pass.toString());
        pass();
      }
    }
    log.groupEnd();
  }

  private finagleJoints(layoutNodesByLayer: LayoutNode[][]): number[] {
    interface Joint {
      x1: number,
      x2: number,
      src: LayoutNode,
      srcPort: number,
      dst: LayoutNode,
    }

    const trackHeights: number[] = [];

    for (const nodes of layoutNodesByLayer) {
      // Get all joints into a list, and sort them left to right by their
      // starting coordinate. This produces the nicest visual nesting.
      const joints: Joint[] = [];
      for (const node of nodes) {
        node.jointOffsets = new Array(node.dstNodes.length).fill(0);

        if (node.block?.attributes.includes("backedge")) {
          continue;
        }

        for (const [srcPort, dst] of node.dstNodes.entries()) {
          const x1 = node.pos.x + PORT_START + PORT_SPACING * srcPort;
          const x2 = dst.pos.x + PORT_START;
          if (Math.abs(x2 - x1) < 2 * ARROW_RADIUS) {
            // Ignore edges that are narrow enough not to render with a joint.
            continue;
          }
          joints.push({ x1, x2, src: node, srcPort, dst });
        }
      }
      joints.sort((a, b) => a.x1 - b.x1);

      // Greedily sort joints into "tracks" based on whether they overlap
      // horizontally with each other. We walk the tracks from the outside in
      // and place the joint in the innermost possible track, stopping if we
      // ever overlap with any other joint.
      const rightwardTracks: Joint[][] = [];
      const leftwardTracks: Joint[][] = [];
      nextJoint:
      for (const joint of joints) {
        const trackSet = joint.x2 - joint.x1 >= 0 ? rightwardTracks : leftwardTracks;
        let lastValidTrack: Joint[] | null = null;
        for (let i = trackSet.length - 1; i >= 0; i--) {
          const track = trackSet[i];
          let overlapsWithAnyInThisTrack = false;
          for (const otherJoint of track) {
            if (joint.dst === otherJoint.dst) {
              // Assign the joint to this track to merge arrows
              track.push(joint);
              continue nextJoint;
            }

            const al = Math.min(joint.x1, joint.x2), ar = Math.max(joint.x1, joint.x2);
            const bl = Math.min(otherJoint.x1, otherJoint.x2), br = Math.max(otherJoint.x1, otherJoint.x2);
            const overlaps = ar >= bl && al <= br;
            if (overlaps) {
              overlapsWithAnyInThisTrack = true;
              break;
            }
          }

          if (overlapsWithAnyInThisTrack) {
            break;
          } else {
            lastValidTrack = track;
          }
        }

        if (lastValidTrack) {
          lastValidTrack.push(joint);
        } else {
          trackSet.push([joint]);
        }
      }

      // Use track info to apply joint offsets to nodes for rendering.
      // We
      const tracksHeight = Math.max(0, rightwardTracks.length + leftwardTracks.length - 1) * JOINT_SPACING;
      let trackOffset = -tracksHeight / 2;
      for (const track of [...rightwardTracks.reverse(), ...leftwardTracks]) {
        for (const joint of track) {
          joint.src.jointOffsets[joint.srcPort] = trackOffset;
        }
        trackOffset += JOINT_SPACING;
      }

      trackHeights.push(tracksHeight);
    }

    assert(trackHeights.length === layoutNodesByLayer.length);
    return trackHeights;
  }

  private verticalize(layoutNodesByLayer: LayoutNode[][], trackHeights: number[]): number[] {
    const layerHeights: number[] = new Array(layoutNodesByLayer.length);

    let nextLayerY = CONTENT_PADDING;
    for (let i = 0; i < layoutNodesByLayer.length; i++) {
      const nodes = layoutNodesByLayer[i];

      let layerHeight = 0;
      for (const node of nodes) {
        node.pos.y = nextLayerY;
        layerHeight = Math.max(layerHeight, node.size.y);
      }

      layerHeights[i] = layerHeight;
      nextLayerY += layerHeight + TRACK_PADDING + trackHeights[i] + TRACK_PADDING;
    }

    return layerHeights;
  }

  private renderBlock(block: Block): HTMLElement {
    const el = document.createElement("div");
    this.graphContainer.appendChild(el);
    el.classList.add("ig-block", "ig-bg-white");
    for (const att of block.attributes) {
      el.classList.add(`ig-block-att-${att}`);
    }
    el.setAttribute("data-ig-block-ptr", `${block.ptr}`);
    el.setAttribute("data-ig-block-id", `${block.id}`);

    let desc = "";
    if (block.attributes.includes("loopheader")) {
      desc = " (loop header)";
    } else if (block.attributes.includes("backedge")) {
      desc = " (backedge)";
    } else if (block.attributes.includes("splitedge")) {
      desc = " (split edge)";
    }
    const header = document.createElement("div");
    header.classList.add("ig-block-header");
    header.innerText = `Block ${block.id}${desc}`;
    el.appendChild(header);

    const insnsContainer = document.createElement("div");
    insnsContainer.classList.add("ig-instructions");
    el.appendChild(insnsContainer);

    const insns = document.createElement("table");
    if (block.lir) {
      insns.innerHTML = `
        <colgroup>
          <col style="width: 1px">
          <col style="width: auto">
          ${this.sampleCounts ? `
            <col style="width: 1px">
            <col style="width: 1px">
          ` : ""}
        </colgroup>
        ${this.sampleCounts ? `
          <thead>
            <tr>
              <th></th>
              <th></th>
              <th class="ig-f6">Total</th>
              <th class="ig-f6">Self</th>
            </tr>
          </thead>
        ` : ""}
      `;
      for (const ins of block.lir.instructions) {
        insns.appendChild(this.renderLIRInstruction(ins));
      }
    } else {
      insns.innerHTML = `
        <colgroup>
          <col style="width: 1px">
          <col style="width: auto">
          <col style="width: 1px">
        </colgroup>
      `;
      for (const ins of block.instructions) {
        insns.appendChild(this.renderMIRInstruction(ins));
      }
    }
    insnsContainer.appendChild(insns);

    if (block.successors.length === 2) {
      for (const [i, label] of [1, 0].entries()) {
        const edgeLabel = document.createElement("div");
        edgeLabel.innerText = `${label}`;
        edgeLabel.classList.add("ig-edge-label");
        edgeLabel.style.left = `${PORT_START + PORT_SPACING * i}px`;
        el.appendChild(edgeLabel);
      }
    }

    // Attach event handlers
    header.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    header.addEventListener("click", e => {
      e.stopPropagation();

      if (!e.shiftKey) {
        this.selectedBlockPtrs.clear();
      }
      this.setSelection([], block.ptr);
    });

    return el;
  }

  private render(nodesByLayer: LayoutNode[][], layerHeights: number[], trackHeights: number[]) {
    // Position blocks according to layout
    for (const nodes of nodesByLayer) {
      for (const node of nodes) {
        if (node.block !== null) {
          const block = node.block;

          block.el.style.left = `${node.pos.x}px`;
          block.el.style.top = `${node.pos.y}px`;
        }
      }
    }

    // Create and size the SVG
    let maxX = 0, maxY = 0;
    for (const nodes of nodesByLayer) {
      for (const node of nodes) {
        maxX = Math.max(maxX, node.pos.x + node.size.x + CONTENT_PADDING);
        maxY = Math.max(maxY, node.pos.y + node.size.y + CONTENT_PADDING);
      }
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.graphContainer.appendChild(svg);

    const trackPositions = (xs: number[], ys: number[]) => {
      for (const x of xs) {
        maxX = Math.max(maxX, x + CONTENT_PADDING);
      }
      for (const y of ys) {
        maxY = Math.max(maxY, y + CONTENT_PADDING);
      }
    };

    // Render arrows
    for (let layer = 0; layer < nodesByLayer.length; layer++) {
      const nodes = nodesByLayer[layer];
      for (const node of nodes) {
        if (!node.block) {
          assert(node.dstNodes.length === 1, `dummy nodes must have exactly one destination, but dummy ${node.id} had ${node.dstNodes.length}`);
        }
        assert(node.dstNodes.length === node.jointOffsets.length, "must have a joint offset for each destination");

        for (const [i, dst] of node.dstNodes.entries()) {
          const x1 = node.pos.x + PORT_START + PORT_SPACING * i;
          const y1 = node.pos.y + node.size.y;

          if (node.block?.attributes.includes("backedge")) {
            // Draw loop header arrow
            const header = node.block.succs[0];
            const x1 = node.pos.x;
            const y1 = node.pos.y + HEADER_ARROW_PUSHDOWN;
            const x2 = header.layoutNode.pos.x + header.size.x;
            const y2 = header.layoutNode.pos.y + HEADER_ARROW_PUSHDOWN;
            const arrow = loopHeaderArrow(x1, y1, x2, y2);
            svg.appendChild(arrow);
            trackPositions([x1, x2], [y1, y2]);
          } else if (node.flags & IMMINENT_BACKEDGE_DUMMY) {
            // Draw from the dummy to the backedge
            const backedge = must(dst.block);
            const x1 = node.pos.x + PORT_START;
            const y1 = node.pos.y + HEADER_ARROW_PUSHDOWN + ARROW_RADIUS;
            const x2 = backedge.layoutNode.pos.x + backedge.size.x;
            const y2 = backedge.layoutNode.pos.y + HEADER_ARROW_PUSHDOWN;
            const arrow = arrowToBackedge(x1, y1, x2, y2);
            svg.appendChild(arrow);
            trackPositions([x1, x2], [y1, y2]);
          } else if (dst.block === null && dst.dstBlock.attributes.includes("backedge")) {
            const x2 = dst.pos.x + PORT_START;
            const y2 = dst.pos.y + ((dst.flags & IMMINENT_BACKEDGE_DUMMY) ? HEADER_ARROW_PUSHDOWN + ARROW_RADIUS : 0);
            if (node.block === null) {
              // Draw upward arrow between dummies
              const ym = y1 - TRACK_PADDING; // this really shouldn't matter because we should straighten all these out
              const arrow = upwardArrow(x1, y1, x2, y2, ym, false);
              svg.appendChild(arrow);
              trackPositions([x1, x2], [y1, y2, ym]);
            } else {
              // Draw arrow to backedge dummy
              const ym = (y1 - node.size.y) + layerHeights[layer] + TRACK_PADDING + trackHeights[layer] / 2 + node.jointOffsets[i];
              const arrow = arrowFromBlockToBackedgeDummy(x1, y1, x2, y2, ym);
              svg.appendChild(arrow);
              trackPositions([x1, x2], [y1, y2, ym]);
            }
          } else {
            const x2 = dst.pos.x + PORT_START;
            const y2 = dst.pos.y;
            const ym = (y1 - node.size.y) + layerHeights[layer] + TRACK_PADDING + trackHeights[layer] / 2 + node.jointOffsets[i];
            const arrow = downwardArrow(x1, y1, x2, y2, ym, dst.block !== null);
            svg.appendChild(arrow);
            trackPositions([x1, x2], [y1, y2, ym]);
          }
        }
      }
    }

    svg.setAttribute("width", `${maxX}`);
    svg.setAttribute("height", `${maxY}`);
    this.size = { x: maxX, y: maxY };

    // Render debug nodes
    if (+DEBUG) {
      for (const nodes of nodesByLayer) {
        for (const node of nodes) {
          const el = document.createElement("div");
          el.innerHTML = `${node.id}<br>&lt;- ${node.srcNodes.map(n => n.id)}<br>-&gt; ${node.dstNodes.map(n => n.id)}<br>${node.flags}`;
          el.style.position = "absolute";
          el.style.border = "1px solid black";
          // el.style.borderWidth = "1px 0 0 1px";
          el.style.backgroundColor = "white";
          el.style.left = `${node.pos.x}px`;
          el.style.top = `${node.pos.y}px`;
          el.style.whiteSpace = "nowrap";
          this.graphContainer.appendChild(el);
        }
      }
    }

    // Final rendering of other effects
    this.updateHighlightedInstructions();
    this.updateHotness();
  }

  private renderMIRInstruction(ins: MIRInstruction): HTMLElement {
    const prettyOpcode = ins.opcode
      .replace('->', '→')
      .replace('<-', '←');

    const row = document.createElement("tr");
    row.classList.add(
      "ig-ins", "ig-ins-mir", "ig-can-flash",
      ...ins.attributes.map(att => `ig-ins-att-${att}`),
    );
    row.setAttribute("data-ig-ins-ptr", `${ins.ptr}`);
    row.setAttribute("data-ig-ins-id", `${ins.id}`);

    const num = document.createElement("td");
    num.classList.add("ig-ins-num");
    num.innerText = String(ins.id);
    row.appendChild(num);

    const opcode = document.createElement("td");
    opcode.innerHTML = prettyOpcode.replace(/([A-Za-z0-9_]+)#(\d+)/g, (_, name, id) => {
      return `<span class="ig-use ig-highlightable" data-ig-use="${id}">${name}#${id}</span>`;
    });
    row.appendChild(opcode);

    const type = document.createElement("td");
    type.classList.add("ig-ins-type");
    type.innerText = ins.type === "None" ? "" : ins.type;
    row.appendChild(type);

    // Event listeners
    num.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    num.addEventListener("click", () => {
      this.toggleInstructionHighlight(ins.ptr);
    });

    opcode.querySelectorAll<HTMLElement>(".ig-use").forEach(use => {
      use.addEventListener("pointerdown", e => {
        e.preventDefault();
        e.stopPropagation();
      });
      use.addEventListener("click", e => {
        const id = parseInt(must(use.getAttribute("data-ig-use")), 10) as InsID;
        this.jumpToInstruction(id, { zoom: 1 });
      });
    });

    return row;
  }

  private renderLIRInstruction(ins: LIRInstruction): HTMLElement {
    const prettyOpcode = ins.opcode
      .replace('->', '→')
      .replace('<-', '←');

    const row = document.createElement("tr");
    row.classList.add("ig-ins", "ig-ins-lir", "ig-hotness");
    row.setAttribute("data-ig-ins-ptr", `${ins.ptr}`);
    row.setAttribute("data-ig-ins-id", `${ins.id}`);

    const num = document.createElement("td");
    num.classList.add("ig-ins-num");
    num.innerText = String(ins.id);
    row.appendChild(num);

    const opcode = document.createElement("td");
    opcode.innerText = prettyOpcode;
    row.appendChild(opcode);

    if (this.sampleCounts) {
      const totalSampleCount = this.sampleCounts?.totalLineHits.get(ins.id) ?? 0;
      const selfSampleCount = this.sampleCounts?.selfLineHits.get(ins.id) ?? 0;

      const totalSamples = document.createElement("td");
      totalSamples.classList.add("ig-ins-samples");
      totalSamples.classList.toggle("ig-text-dim", totalSampleCount === 0);
      totalSamples.innerText = `${totalSampleCount}`;
      totalSamples.title = "Color by total count";
      row.appendChild(totalSamples);

      const selfSamples = document.createElement("td");
      selfSamples.classList.add("ig-ins-samples");
      selfSamples.classList.toggle("ig-text-dim", selfSampleCount === 0);
      selfSamples.innerText = `${selfSampleCount}`;
      selfSamples.title = "Color by self count";
      row.appendChild(selfSamples);

      // Event listeners
      for (const [i, el] of [totalSamples, selfSamples].entries()) {
        el.addEventListener("pointerdown", e => {
          e.preventDefault();
          e.stopPropagation();
        });
        el.addEventListener("click", () => {
          assert(i === SC_TOTAL || i === SC_SELF);
          this.heatmapMode = i;
          this.updateHotness();
        });
      }
    }

    // Event listeners
    num.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    num.addEventListener("click", () => {
      this.toggleInstructionHighlight(ins.ptr);
    });

    return row;
  }

  private renderSelection() {
    this.graphContainer.querySelectorAll(".ig-block").forEach(blockEl => {
      const ptr = parseInt(must(blockEl.getAttribute("data-ig-block-ptr")), 10) as BlockPtr;
      blockEl.classList.toggle("ig-selected", this.selectedBlockPtrs.has(ptr));
      blockEl.classList.toggle("ig-last-selected", this.lastSelectedBlockPtr === ptr);
    });
  }

  private removeNonexistentHighlights() {
    this.highlightedInstructions = this.highlightedInstructions.filter(hi => {
      return this.graphContainer.querySelector<HTMLElement>(`.ig-ins[data-ig-ins-ptr="${hi.ptr}"]`);
    });
  }

  private updateHighlightedInstructions() {
    for (const hi of this.highlightedInstructions) {
      assert(this.highlightedInstructions.filter(other => other.ptr === hi.ptr).length === 1, `instruction ${hi.ptr} was highlighted more than once`);
    }

    // Clear all existing highlight styles
    this.graphContainer.querySelectorAll<HTMLElement>(".ig-ins, .ig-use").forEach(ins => {
      clearHighlight(ins);
    });

    // Highlight all instructions
    for (const hi of this.highlightedInstructions) {
      const color = this.instructionPalette[hi.paletteColor % this.instructionPalette.length];
      const row = this.graphContainer.querySelector<HTMLElement>(`.ig-ins[data-ig-ins-ptr="${hi.ptr}"]`);
      if (row) {
        highlight(row, color);

        const id = this.insIDsByPtr.get(hi.ptr);
        this.graphContainer.querySelectorAll<HTMLElement>(`.ig-use[data-ig-use="${id}"]`).forEach(use => {
          highlight(use, color);
        });
      }
    }
  }

  private updateHotness() {
    this.graphContainer.querySelectorAll<HTMLElement>(".ig-ins-lir").forEach(insEl => {
      assert(insEl.classList.contains("ig-hotness"));
      const insID = parseInt(must(insEl.getAttribute("data-ig-ins-id")), 10);
      let hotness = 0;
      if (this.sampleCounts) {
        const counts = this.heatmapMode === SC_TOTAL ? this.sampleCounts.totalLineHits : this.sampleCounts.selfLineHits;
        hotness = (counts.get(insID) ?? 0) / this.maxSampleCounts[this.heatmapMode];
      }
      insEl.style.setProperty("--ig-hotness", `${hotness}`);
    });
  }

  private addEventListeners() {
    this.viewport.addEventListener("wheel", e => {
      e.preventDefault();

      let newZoom = this.zoom;
      if (e.ctrlKey) {
        newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * Math.pow(ZOOM_SENSITIVITY, -e.deltaY * WHEEL_DELTA_SCALE)));
        const zoomDelta = (newZoom / this.zoom) - 1;
        this.zoom = newZoom;

        const { x: gx, y: gy } = this.viewport.getBoundingClientRect();
        const mouseOffsetX = (e.clientX - gx) - this.translation.x;
        const mouseOffsetY = (e.clientY - gy) - this.translation.y;
        this.translation.x -= mouseOffsetX * zoomDelta;
        this.translation.y -= mouseOffsetY * zoomDelta;
      } else {
        this.translation.x -= e.deltaX;
        this.translation.y -= e.deltaY;
      }

      const clampedT = this.clampTranslation(this.translation, newZoom);
      this.translation.x = clampedT.x;
      this.translation.y = clampedT.y;

      this.animating = false;
      this.updatePanAndZoom();
    });
    this.viewport.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && !(e.button === 0 || e.button === 1)) {
        return;
      }

      e.preventDefault();
      this.viewport.setPointerCapture(e.pointerId);
      this.startMousePos = {
        x: e.clientX,
        y: e.clientY,
      };
      this.lastMousePos = {
        x: e.clientX,
        y: e.clientY,
      };
      this.animating = false;
    });
    this.viewport.addEventListener("pointermove", e => {
      if (!this.viewport.hasPointerCapture(e.pointerId)) {
        return;
      }

      const dx = (e.clientX - this.lastMousePos.x);
      const dy = (e.clientY - this.lastMousePos.y);
      this.translation.x += dx;
      this.translation.y += dy;
      this.lastMousePos = {
        x: e.clientX,
        y: e.clientY,
      };

      const clampedT = this.clampTranslation(this.translation, this.zoom);
      this.translation.x = clampedT.x;
      this.translation.y = clampedT.y;

      this.animating = false;
      this.updatePanAndZoom();
    });
    this.viewport.addEventListener("pointerup", e => {
      this.viewport.releasePointerCapture(e.pointerId);

      const THRESHOLD = 2;
      const deltaX = this.startMousePos.x - e.clientX;
      const deltaY = this.startMousePos.y - e.clientY;
      if (Math.abs(deltaX) <= THRESHOLD && Math.abs(deltaY) <= THRESHOLD) {
        this.setSelection([]);
      }

      this.animating = false;
    });

    // Observe resizing of the viewport (so we don't have to trigger style
    // calculation in hot paths)
    const ro = new ResizeObserver(entries => {
      assert(entries.length === 1);
      const rect = entries[0].contentRect;
      this.viewportSize.x = rect.width;
      this.viewportSize.y = rect.height;
    });
    ro.observe(this.viewport);
  }

  setSelection(blockPtrs: BlockPtr[], lastSelectedPtr: BlockPtr = 0 as BlockPtr) {
    this.setSelectionRaw(blockPtrs, lastSelectedPtr);
    if (!lastSelectedPtr) {
      this.nav = {
        visited: [],
        currentIndex: -1,
        siblings: [],
      };
    } else {
      this.nav = {
        visited: [lastSelectedPtr],
        currentIndex: 0,
        siblings: [lastSelectedPtr],
      };
    }
  }

  private setSelectionRaw(blockPtrs: BlockPtr[], lastSelectedPtr: BlockPtr) {
    this.selectedBlockPtrs.clear();
    for (const blockPtr of [...blockPtrs, lastSelectedPtr]) {
      if (this.blocksByPtr.has(blockPtr)) {
        this.selectedBlockPtrs.add(blockPtr);
      }
    }
    this.lastSelectedBlockPtr = this.blocksByPtr.has(lastSelectedPtr) ? lastSelectedPtr : 0 as BlockPtr;
    this.renderSelection();
  }

  navigate(dir: "down" | "up" | "left" | "right") {
    const selected = this.lastSelectedBlockPtr;

    if (dir === "down" || dir === "up") {
      // Vertical navigation
      if (!selected) {
        const blocks = this.blocksInOrder;
        // No block selected; start navigation anew
        const rootBlocks = blocks.filter(b => b.predecessors.length === 0);
        const leafBlocks = blocks.filter(b => b.successors.length === 0);
        const fauxSiblings = dir === "down" ? rootBlocks : leafBlocks;
        const firstBlock = fauxSiblings[0];
        assert(firstBlock);
        this.setSelectionRaw([], firstBlock.ptr);
        this.nav = {
          visited: [firstBlock.ptr],
          currentIndex: 0,
          siblings: fauxSiblings.map(b => b.ptr),
        };
      } else {
        // Move to the current block's successors or predecessors,
        // respecting the visited stack
        const currentBlock = must(this.blocksByPtr.get(selected));
        const nextSiblings: BlockPtr[] = (
          dir === "down"
            ? currentBlock.successors
            : currentBlock.predecessors
        ).map(id => must(this.blocksByID.get(id)).ptr);

        // If we have navigated to a different sibling at our current point in
        // the stack, we have gone off our prior track and start a new one.
        if (currentBlock.ptr !== this.nav.visited[this.nav.currentIndex]) {
          this.nav.visited = [currentBlock.ptr];
          this.nav.currentIndex = 0;
        }

        const nextIndex = this.nav.currentIndex + (dir === "down" ? 1 : -1);
        if (0 <= nextIndex && nextIndex < this.nav.visited.length) {
          // Move to existing block in visited stack
          this.nav.currentIndex = nextIndex;
          this.nav.siblings = nextSiblings;
        } else {
          // Push a new block onto the visited stack (either at the front or back)
          const next: BlockPtr | undefined = nextSiblings[0];
          if (next !== undefined) {
            if (dir === "down") {
              this.nav.visited.push(next);
              this.nav.currentIndex += 1;
              assert(this.nav.currentIndex === this.nav.visited.length - 1);
            } else {
              this.nav.visited.unshift(next);
              assert(this.nav.currentIndex === 0);
            }
            this.nav.siblings = nextSiblings;
          }
        }

        this.setSelectionRaw([], this.nav.visited[this.nav.currentIndex]);
      }
    } else {
      // Horizontal navigation
      if (selected !== undefined) {
        const i = this.nav.siblings.indexOf(selected);
        assert(i >= 0, "currently selected node should be in siblings array");
        const nextI = i + (dir === "right" ? 1 : -1);
        if (0 <= nextI && nextI < this.nav.siblings.length) {
          this.setSelectionRaw([], this.nav.siblings[nextI]);
        }
      }
    }

    assert(this.nav.visited.length === 0 || this.nav.siblings.includes(this.nav.visited[this.nav.currentIndex]), "expected currently visited node to be in the siblings array");
    assert(this.lastSelectedBlockPtr === 0 || this.nav.siblings.includes(this.lastSelectedBlockPtr), "expected currently selected block to be in siblings array");
  }

  toggleInstructionHighlight(insPtr: InsPtr, force?: boolean) {
    this.removeNonexistentHighlights();

    const indexOfExisting = this.highlightedInstructions.findIndex(hi => hi.ptr === insPtr);
    let remove = indexOfExisting >= 0;
    if (force !== undefined) {
      remove = !force;
    }

    if (remove) {
      if (indexOfExisting >= 0) {
        this.highlightedInstructions.splice(indexOfExisting, 1);
      }
    } else {
      if (indexOfExisting < 0) {
        let nextPaletteColor = 0;
        while (true) {
          if (this.highlightedInstructions.find(hi => hi.paletteColor === nextPaletteColor)) {
            nextPaletteColor += 1;
            continue;
          }
          break;
        }

        this.highlightedInstructions.push({
          ptr: insPtr,
          paletteColor: nextPaletteColor,
        });
      }
    }

    this.updateHighlightedInstructions();
  }

  private clampTranslation(t: Vec2, scale: number): Vec2 {
    const minX = TRANSLATION_CLAMP_AMOUNT - this.size.x * scale;
    const maxX = this.viewportSize.x - TRANSLATION_CLAMP_AMOUNT;
    const minY = TRANSLATION_CLAMP_AMOUNT - this.size.y * scale;
    const maxY = this.viewportSize.y - TRANSLATION_CLAMP_AMOUNT;

    const newX = clamp(t.x, minX, maxX);
    const newY = clamp(t.y, minY, maxY);

    return { x: newX, y: newY };
  }

  updatePanAndZoom() {
    // We clamp here as well as in the input events because we want to respect
    // the clamped limits even when jumping from pass to pass. But then when we
    // actually receive input we want the clamping to "stick".
    const clampedT = this.clampTranslation(this.translation, this.zoom);
    this.graphContainer.style.transform = `translate(${clampedT.x}px, ${clampedT.y}px) scale(${this.zoom})`;
  }

  /**
   * Converts from graph space to viewport space.
   */
  graph2viewport(v: Vec2, translation: Vec2 = this.translation, zoom: number = this.zoom): Vec2 {
    return {
      x: v.x * zoom + translation.x,
      y: v.y * zoom + translation.y,
    };
  }

  /**
   * Converts from viewport space to graph space.
   */
  viewport2graph(v: Vec2, translation: Vec2 = this.translation, zoom: number = this.zoom): Vec2 {
    return {
      x: (v.x - translation.x) / zoom,
      y: (v.y - translation.y) / zoom,
    };
  }

  /**
   * Pans and zooms the graph such that the given x and y in graph space are in
   * the top left of the viewport.
   */
  async goToGraphCoordinates(
    coords: Vec2,
    { zoom = this.zoom, animate = true }: {
      zoom?: number,
      animate?: boolean
    },
  ) {
    const newTranslation = { x: -coords.x * zoom, y: -coords.y * zoom };

    if (!animate) {
      this.animating = false;
      this.translation.x = newTranslation.x;
      this.translation.y = newTranslation.y;
      this.zoom = zoom;
      this.updatePanAndZoom();
      await new Promise(res => setTimeout(res, 0));
      return;
    }

    this.targetTranslation = newTranslation;
    this.targetZoom = zoom;
    if (this.animating) {
      // Do not start another animation loop.
      //
      // TODO: Be fancy and return a promise that will resolve when the
      // existing animation loop resolves.
      return;
    }

    this.animating = true;
    let lastTime = performance.now();
    while (this.animating) {
      const now = await new Promise<number>(res => requestAnimationFrame(res));
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const THRESHOLD_T = 1, THRESHOLD_ZOOM = 0.01;
      const R = 0.000001; // fraction remaining after one second: smaller = faster
      const dx = this.targetTranslation.x - this.translation.x;
      const dy = this.targetTranslation.y - this.translation.y;
      const dzoom = this.targetZoom - this.zoom;
      this.translation.x = filerp(this.translation.x, this.targetTranslation.x, R, dt);
      this.translation.y = filerp(this.translation.y, this.targetTranslation.y, R, dt);
      this.zoom = filerp(this.zoom, this.targetZoom, R, dt);
      this.updatePanAndZoom();

      if (
        Math.abs(dx) <= THRESHOLD_T
        && Math.abs(dy) <= THRESHOLD_T
        && Math.abs(dzoom) <= THRESHOLD_ZOOM
      ) {
        this.translation.x = this.targetTranslation.x;
        this.translation.y = this.targetTranslation.y;
        this.zoom = this.targetZoom;
        this.animating = false;
        this.updatePanAndZoom();
        break;
      }
    }

    // Delay by one update so that CSS changes before/after animation will
    // always take effect, e.g. for .ig-flash.
    await new Promise(res => setTimeout(res, 0));
  }

  jumpToBlock(
    blockPtr: BlockPtr,
    { zoom = this.zoom, animate = true, viewportPos }: {
      zoom?: number,
      animate?: boolean,
      viewportPos?: Vec2,
    } = {},
  ) {
    const block = this.blocksByPtr.get(blockPtr);
    if (!block) {
      return Promise.resolve();
    }

    let graphCoords: Vec2;
    if (viewportPos) {
      graphCoords = {
        x: block.layoutNode.pos.x - viewportPos.x / zoom,
        y: block.layoutNode.pos.y - viewportPos.y / zoom,
      };
    } else {
      graphCoords = this.graphPosToCenterRect(block.layoutNode.pos, block.layoutNode.size, zoom);
    }
    return this.goToGraphCoordinates(graphCoords, { zoom, animate });
  }

  async jumpToInstruction(
    insID: InsID,
    { zoom = this.zoom, animate = true }: {
      zoom?: number,
      animate?: boolean,
    },
  ) {
    // Since we don't have graph-layout coordinates for instructions, we have
    // to reverse engineer them from their client position.
    const insEl = this.graphContainer.querySelector<HTMLElement>(`.ig-ins[data-ig-ins-id="${insID}"]`);
    if (!insEl) {
      return;
    }

    const insRect = insEl.getBoundingClientRect();
    const graphRect = this.graphContainer.getBoundingClientRect();

    const x = (insRect.x - graphRect.x) / this.zoom;
    const y = (insRect.y - graphRect.y) / this.zoom;
    const width = insRect.width / this.zoom;
    const height = insRect.height / this.zoom;

    const coords = this.graphPosToCenterRect({ x, y }, { x: width, y: height }, zoom);
    insEl.classList.add("ig-flash");
    await this.goToGraphCoordinates(coords, { zoom, animate });
    insEl.classList.remove("ig-flash");
  }

  /**
   * Returns the position in graph space that, if panned to, will center the
   * given graph-space rectangle in the viewport.
   */
  graphPosToCenterRect(pos: Vec2, size: Vec2, zoom: number): Vec2 {
    const viewportWidth = this.viewportSize.x / zoom;
    const viewportHeight = this.viewportSize.y / zoom;
    const xPadding = Math.max(20 / zoom, (viewportWidth - size.x) / 2);
    const yPadding = Math.max(20 / zoom, (viewportHeight - size.y) / 2);
    const x = pos.x - xPadding;
    const y = pos.y - yPadding;
    return { x, y };
  }

  exportState(): GraphState {
    const state: GraphState = {
      translation: this.translation,
      zoom: this.zoom,
      heatmapMode: this.heatmapMode,
      highlightedInstructions: this.highlightedInstructions,
      selectedBlockPtrs: this.selectedBlockPtrs,
      lastSelectedBlockPtr: this.lastSelectedBlockPtr,

      viewportPosOfSelectedBlock: undefined,
    };

    if (this.lastSelectedBlockPtr) {
      state.viewportPosOfSelectedBlock = this.graph2viewport(must(this.blocksByPtr.get(this.lastSelectedBlockPtr)).layoutNode.pos);
    }

    return state;
  }

  restoreState(state: GraphState, opts: RestoreStateOpts) {
    this.translation.x = state.translation.x;
    this.translation.y = state.translation.y;
    this.zoom = state.zoom;
    this.heatmapMode = state.heatmapMode;
    this.highlightedInstructions = state.highlightedInstructions;
    this.setSelection(Array.from(state.selectedBlockPtrs), state.lastSelectedBlockPtr);

    this.updatePanAndZoom();
    this.updateHotness();
    this.updateHighlightedInstructions();

    if (opts.preserveSelectedBlockPosition) {
      // If there was no last selected block, or if the last selected block no
      // longer exists, jumpToBlock will do nothing. This is fine.
      this.jumpToBlock(this.lastSelectedBlockPtr, {
        zoom: this.zoom,
        animate: false,
        viewportPos: state.viewportPosOfSelectedBlock,
      });
    }
  }
}

function pruneNode(node: LayoutNode) {
  for (const dst of node.dstNodes) {
    const indexOfSelfInDst = dst.srcNodes.indexOf(node);
    assert(indexOfSelfInDst !== -1);
    dst.srcNodes.splice(indexOfSelfInDst, 1);
  }
}

function* dummies(layoutNodesByLayer: LayoutNode[][]) {
  for (const nodes of layoutNodesByLayer) {
    for (const node of nodes) {
      if (node.block === null) {
        yield node;
      }
    }
  }
}

function* backedgeDummies(layoutNodesByLayer: LayoutNode[][]) {
  for (const nodes of layoutNodesByLayer) {
    for (const node of nodes) {
      if (node.block === null && node.dstBlock.attributes.includes("backedge")) {
        yield node;
      }
    }
  }
}

function downwardArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  doArrowhead: boolean,
  stroke = 1,
): SVGElement {
  const r = ARROW_RADIUS;
  assert(y1 + r <= ym && ym < y2 - r, `downward arrow: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r} `, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    x2 += 0.5;
    ym += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start

  if (Math.abs(x2 - x1) < 2 * r) {
    // Degenerate case where the radii won't fit; fall back to bezier.
    path += `C ${x1} ${y1 + (y2 - y1) / 3} ${x2} ${y1 + 2 * (y2 - y1) / 3} ${x2} ${y2} `;
  } else {
    const dir = Math.sign(x2 - x1);
    path += `L ${x1} ${ym - r} `; // line down
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${x1 + r * dir} ${ym} `; // arc to joint
    path += `L ${x2 - r * dir} ${ym} `; // joint
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x2} ${ym + r} `; // arc to line
    path += `L ${x2} ${y2} `; // line down
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke} `);
  g.appendChild(p);

  if (doArrowhead) {
    const v = arrowhead(x2, y2, 180);
    g.appendChild(v);
  }

  return g;
}

function upwardArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  doArrowhead: boolean,
  stroke = 1,
): SVGElement {
  const r = ARROW_RADIUS;
  assert(y2 + r <= ym && ym <= y1 - r, `upward arrow: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r} `, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    x2 += 0.5;
    ym += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start

  if (Math.abs(x2 - x1) < 2 * r) {
    // Degenerate case where the radii won't fit; fall back to bezier.
    path += `C ${x1} ${y1 + (y2 - y1) / 3} ${x2} ${y1 + 2 * (y2 - y1) / 3} ${x2} ${y2} `;
  } else {
    const dir = Math.sign(x2 - x1);
    path += `L ${x1} ${ym + r} `; // line up
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x1 + r * dir} ${ym} `; // arc to joint
    path += `L ${x2 - r * dir} ${ym} `; // joint
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${x2} ${ym - r} `; // arc to line
    path += `L ${x2} ${y2} `; // line up
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke} `);
  g.appendChild(p);

  if (doArrowhead) {
    const v = arrowhead(x2, y2, 0);
    g.appendChild(v);
  }

  return g;
}

function arrowToBackedge(
  x1: number, y1: number,
  x2: number, y2: number,
  stroke = 1,
): SVGElement {
  const r = ARROW_RADIUS;
  assert(y1 - r >= y2 && x1 - r >= x2, `to backedge: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, r = ${r} `, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    y2 += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `A ${r} ${r} 0 0 0 ${x1 - r} ${y2} `; // arc to line
  path += `L ${x2} ${y2} `; // line left

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke} `);
  g.appendChild(p);

  const v = arrowhead(x2, y2, 270);
  g.appendChild(v);

  return g;
}

function arrowFromBlockToBackedgeDummy(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  stroke = 1,
): SVGElement {
  const r = ARROW_RADIUS;
  assert(y1 + r <= ym && x1 <= x2 && y2 <= y1, `block to backedge dummy: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r} `, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    x2 += 0.5;
    ym += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x1} ${ym - r} `; // line down
  path += `A ${r} ${r} 0 0 0 ${x1 + r} ${ym} `; // arc to horizontal joint
  path += `L ${x2 - r} ${ym} `; // horizontal joint
  path += `A ${r} ${r} 0 0 0 ${x2} ${ym - r} `; // arc to line
  path += `L ${x2} ${y2} `; // line up

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke} `);
  g.appendChild(p);

  return g;
}

function loopHeaderArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  stroke = 1,
): SVGElement {
  assert(x2 < x1 && y2 === y1, `x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2} `, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    y1 += 0.5;
    y2 += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x2} ${y2} `; // line left

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke} `);
  g.appendChild(p);

  const v = arrowhead(x2, y2, 270);
  g.appendChild(v);

  return g;
}

function arrowhead(x: number, y: number, rot: number, size = 5): SVGElement {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", `M 0 0 L ${-size} ${size * 1.5} L ${size} ${size * 1.5} Z`);
  p.setAttribute("transform", `translate(${x}, ${y}) rotate(${rot})`);
  return p;
}

function highlight(el: HTMLElement, color: string) {
  el.classList.add("ig-highlight");
  el.style.setProperty("--ig-highlight-color", color);
}

function clearHighlight(el: HTMLElement) {
  el.classList.remove("ig-highlight");
  el.style.setProperty("--ig-highlight-color", "transparent");
}
