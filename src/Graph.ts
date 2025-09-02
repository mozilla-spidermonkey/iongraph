import type { MIRBlock, LIRBlock, LIRInstruction, MIRInstruction, Pass } from "./iongraph.js";
import { tweak } from "./tweak.js";
import { assert, must } from "./utils.js";

const DEBUG = tweak("Debug?", 0, { min: 0, max: 1 });

const CONTENT_PADDING = 20;
const BLOCK_GAP = 44;
const PORT_START = 16;
const PORT_SPACING = 60;
const ARROW_RADIUS = 12;
const TRACK_PADDING = 36;
const JOINT_SPACING = 16;
const HEADER_ARROW_PUSHDOWN = 16;
const BACKEDGE_ARROW_PUSHOUT = 32;

const LAYOUT_ITERATIONS = tweak("Layout Iterations", 2, { min: 0, max: 6 });
const NEARLY_STRAIGHT = tweak("Nearly Straight Threshold", 30, { min: 0, max: 200 });
const NEARLY_STRAIGHT_ITERATIONS = tweak("Nearly Straight Iterations", 4, { min: 0, max: 10 });
const STOP_AT_PASS = tweak("Stop At Pass", 30, { min: 0, max: 30 });

interface Vec2 {
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
  loopID: number,
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
  throw new Error("Block is not a LoopHeader");
}

function asLH(block: Block | undefined): LoopHeader {
  assert(block);
  if (isLH(block)) {
    return block as LoopHeader;
  }
  throw new Error("Block is not a pseudo LoopHeader");
}

type LayoutNode = BlockNode | DummyNode;

interface _LayoutNodeCommon {
  id: number,
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
  /** Chain of nodes visited by navigating up and down */
  visited: number[],

  /** Current index into {@link visited} */
  currentIndex: number,

  /** Current set of sibling nodes to navigate sideways */
  siblings: number[],
}

export class Graph {
  container: HTMLElement;
  pass: Pass;
  blocks: Block[];
  blocksInOrder: Block[];
  blocksByNum: Map<number, Block>;
  loops: LoopHeader[];

  width: number;
  height: number;
  numLayers: number;

  selectedBlocks: Set<number>;
  lastSelectedBlock: number | undefined;
  nav: GraphNavigation;

  constructor(container: HTMLElement, pass: Pass) {
    const blocks = pass.mir.blocks as Block[];

    this.container = container;
    this.pass = pass;
    this.blocks = blocks;
    this.blocksInOrder = [...blocks].sort((a, b) => a.number - b.number);
    this.blocksByNum = new Map();

    this.loops = []; // top-level loops; this basically forms the root of the loop tree

    this.width = 0;
    this.height = 0;
    this.numLayers = 0;

    this.selectedBlocks = new Set();
    this.lastSelectedBlock = undefined;
    this.nav = {
      visited: [],
      currentIndex: -1,
      siblings: [],
    };

    const lirBlocks = new Map<number, LIRBlock>();
    for (const lir of pass.lir.blocks) {
      lirBlocks.set(lir.number, lir);
    }

    // Initialize blocks
    for (const block of blocks) {
      this.blocksByNum.set(block.number, block);

      block.lir = lirBlocks.get(block.number) ?? null;

      const el = this.renderBlock(block);
      block.el = el;

      block.size = {
        x: el.clientWidth,
        y: el.clientHeight,
      };

      block.layer = -1;
      block.loopID = 0;
      if (block.attributes.includes("loopheader")) {
        const lh = block as LoopHeader;
        lh.loopHeight = 0;
        lh.parentLoop = null;
        lh.outgoingEdges = [];
      }
    }

    // After putting all blocks in our map, fill out block-to-block references.
    for (const block of blocks) {
      block.preds = block.predecessors.map(id => must(this.blocksByNum.get(id)));
      block.succs = block.successors.map(id => must(this.blocksByNum.get(id)));

      if (isTrueLH(block)) {
        const backedges = block.preds.filter(b => b.attributes.includes("backedge"));
        assert(backedges.length === 1);
        block.backedge = backedges[0];
      }
    }

    const [nodesByLayer, layerHeights, trackHeights] = this.layout();
    this.render(nodesByLayer, layerHeights, trackHeights);
  }

  private layout(): [LayoutNode[][], number[], number[]] {
    const roots = this.blocks.filter(b => b.predecessors.length === 0);

    // Make the roots into pseudo loop headers.
    for (const r of roots) {
      const root = r as LoopHeader;
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
      this.findLoops(r);
      this.layer(r);
    }
    const layoutNodesByLayer = this.makeLayoutNodes();
    this.straightenEdges(layoutNodesByLayer);
    const trackHeights = this.finagleJoints(layoutNodesByLayer);
    const layerHeights = this.verticalize(layoutNodesByLayer, trackHeights);

    return [layoutNodesByLayer, layerHeights, trackHeights];
  }

  // Walks through the graph tracking which loop each block belongs to. As
  // each block is visited, it is assigned the current loop ID. If the
  // block has lesser loopDepth than its parent, that means it is outside
  // at least one loop, and the loop it belongs to can be looked up by loop
  // depth.
  private findLoops(block: Block, loopIDsByDepth: number[] | null = null) {
    if (loopIDsByDepth === null) {
      loopIDsByDepth = [block.number];
    }

    if (isTrueLH(block)) {
      assert(block.loopDepth === loopIDsByDepth.length);
      const parentID = loopIDsByDepth[loopIDsByDepth.length - 1];
      const parent = asLH(this.blocksByNum.get(parentID));
      block.parentLoop = parent;

      loopIDsByDepth = [...loopIDsByDepth, block.number];
    }

    if (block.loopDepth < loopIDsByDepth.length - 1) {
      loopIDsByDepth = loopIDsByDepth.slice(0, block.loopDepth + 1);
    }
    assert(block.loopDepth < loopIDsByDepth.length);
    block.loopID = loopIDsByDepth[block.loopDepth];

    if (!block.attributes.includes("backedge")) {
      for (const succ of block.succs) {
        this.findLoops(succ, loopIDsByDepth);
      }
    }
  }

  private layer(block: Block, layer = 0) {
    if (block.attributes.includes("backedge")) {
      block.layer = block.succs[0].layer;
      return;
    }

    block.layer = Math.max(block.layer, layer);
    this.numLayers = Math.max(block.layer + 1, this.numLayers);

    let loopHeader: LoopHeader | null = asLH(this.blocksByNum.get(block.loopID));
    while (loopHeader) {
      loopHeader.loopHeight = Math.max(loopHeader.loopHeight, block.layer - loopHeader.layer + 1);
      loopHeader = loopHeader.parentLoop;
    }

    for (const succ of block.succs) {
      if (succ.loopDepth < block.loopDepth) {
        // This is an outgoing edge from the current loop.
        // Track it on our current loop's header to be layered later.
        const loopHeader = asLH(this.blocksByNum.get(block.loopID));
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
    function connectNodes(from: LayoutNode, fromPort: number, to: LayoutNode) {
      from.dstNodes[fromPort] = to;
      if (!to.srcNodes.includes(from)) {
        to.srcNodes.push(from);
      }
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

    let nodeID = 0;

    const layoutNodesByLayer: LayoutNode[][] = blocksByLayer.map(() => []);
    const activeEdges: IncompleteEdge[] = [];
    const latestDummiesForBackedges = new Map<Block, DummyNode>();
    for (const [layer, blocks] of blocksByLayer.entries()) {
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

        const existingDummy = dummiesByDest.get(edge.dstBlock.number)
        if (existingDummy) {
          // Collapse multiple edges into a single dummy node.
          connectNodes(edge.src, edge.srcPort, existingDummy);
          dummy = existingDummy;
        } else {
          // Create a new dummy node.
          const newDummy: DummyNode = {
            id: nodeID++,
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
          dummiesByDest.set(edge.dstBlock.number, newDummy);
          dummy = newDummy;
        }

        // Update the active edge with the latest dummy.
        edge.src = dummy;
        edge.srcPort = 0;
      }

      // Track which blocks will get backedge dummy nodes.
      interface PendingLoopDummy {
        loopID: number,
        block: Block,
      }
      const pendingLoopDummies: PendingLoopDummy[] = [];
      for (const block of blocks) {
        let currentLoopHeader = asLH(this.blocksByNum.get(block.loopID));
        while (isTrueLH(currentLoopHeader)) {
          const existing = pendingLoopDummies.find(d => d.loopID === currentLoopHeader.number);
          if (existing) {
            // We have seen this loop before but have a new rightmost block for
            // it. Update which block should get the dummy.
            existing.block = block;
          } else {
            // This loop has not been seen before, so track it.
            pendingLoopDummies.push({ loopID: currentLoopHeader.number, block: block });
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
          id: nodeID++,
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
          const backedge = asLH(this.blocksByNum.get(loopDummy.loopID)).backedge;
          const backedgeDummy: DummyNode = {
            id: nodeID++,
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
    }

    // Prune backedge dummies that don't have a source. This can happen because
    // we always generate dummy nodes at each level for active loops, but if a
    // loop doesn't branch back at the end, several dummy nodes will be left
    // orphaned.
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
    for (const layer of layoutNodesByLayer) {
      for (const node of layer) {
        if (node.block) {
          assert(node.dstNodes.length === node.block.successors.length, `expected node ${node.id} for block ${node.block.number} to have ${node.block.successors.length} destination nodes, but got ${node.dstNodes.length} instead`);
        } else {
          assert(node.dstNodes.length === 1, `expected dummy node ${node.id} to have only one destination node, but got ${node.dstNodes.length} instead`);
        }
        for (let i = 0; i < node.dstNodes.length; i++) {
          assert(node.dstNodes[i] !== undefined, `dst slot ${i} of node ${node.id} was undefined`);
        }
      }
    }

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
        const backedgeNeighborPosition = node.block?.attributes.includes("backedge") ? node.pos.x + node.size.x + BACKEDGE_ARROW_PUSHOUT + BLOCK_GAP + PORT_START : 0;
        neighbor.pos.x = Math.max(neighbor.pos.x, nodeRightPlusPadding, backedgeNeighborPosition);
      }
    };

    // Push nodes to the right so they fit inside their loop.
    const pushIntoLoops = () => {
      for (const nodes of layoutNodesByLayer) {
        for (const node of nodes) {
          if (node.block === null) {
            continue;
          }

          const loopHeader = node.block.loopID !== null ? asLH(this.blocksByNum.get(node.block.loopID)) : null;
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
        if (dummy.dstNodes[0].block && dst.attributes.includes("backedge")) {
          // Direct input to backedge
          const backedgeNode = dst.layoutNode;
          desiredX = backedgeNode.pos.x + backedgeNode.size.x + BACKEDGE_ARROW_PUSHOUT;
        }
        dummyLinePositions.set(dst, Math.max(dummyLinePositions.get(dst) ?? 0, desiredX));
      }

      // Apply positions to dummies
      for (const dummy of dummies(layoutNodesByLayer)) {
        const backedge = dummy.dstBlock;
        const x = dummyLinePositions.get(backedge);
        assert(x, `no position for backedge ${backedge.number}`);
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
          for (const src of dummy.srcNodes) {
            const srcX = src.pos.x + src.dstNodes.indexOf(dummy) * PORT_SPACING;
            if (srcX < maxSafeX) {
              maxSafeX = srcX;
            }
          }
          if (dummy.dstBlock.layoutNode.pos.x < maxSafeX) {
            maxSafeX = dummy.dstBlock.layoutNode.pos.x;
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
        assert(x, `no position for run to block ${dummy.dstBlock.number}`);
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
    function mirOpToHTML(ins: MIRInstruction): HTMLElement {
      const prettyOpcode = ins.opcode
        .replace('->', '→')
        .replace('<-', '←');

      const row = document.createElement("tr");
      row.classList.add(...ins.attributes.map(att => `ig-ins-att-${att}`));
      row.setAttribute("data-ig-mir-op-id", `${ins.id}`);

      const num = document.createElement("td");
      num.classList.add("ig-op-num");
      num.innerText = String(ins.id);
      row.appendChild(num);

      const opcode = document.createElement("td");
      opcode.innerText = prettyOpcode;
      row.appendChild(opcode);

      const type = document.createElement("td");
      type.classList.add("ig-op-type");
      type.innerText = ins.type === "None" ? "" : ins.type;
      row.appendChild(type);

      return row;
    }

    function lirOpToHTML(ins: LIRInstruction): HTMLElement {
      const prettyOpcode = ins.opcode
        .replace('->', '→')
        .replace('<-', '←');

      const row = document.createElement("tr");
      row.setAttribute("data-ig-lir-op-id", `${ins.id}`);

      const num = document.createElement("td");
      num.classList.add("ig-op-num");
      num.innerText = String(ins.id);
      row.appendChild(num);

      const opcode = document.createElement("td");
      opcode.innerText = prettyOpcode;
      row.appendChild(opcode);

      const type = document.createElement("td");
      type.classList.add("ig-op-type");
      row.appendChild(type);

      return row;
    }

    const el = document.createElement("div");
    this.container.appendChild(el);
    el.classList.add("ig-block");
    for (const att of block.attributes) {
      el.classList.add(`ig-block-att-${att}`);
    }
    el.setAttribute("data-ig-block-number", `${block.number}`);

    let desc = "";
    if (block.attributes.includes("loopheader")) {
      desc = " (loop header)";
    } else if (block.attributes.includes("backedge")) {
      desc = " (backedge)";
    } else if (block.attributes.includes("splitedge")) {
      desc = " (split edge)";
    }
    const header = document.createElement("h2");
    header.innerText = `Block ${block.number}${desc}`;
    el.appendChild(header);

    const insnsContainer = document.createElement("div");
    insnsContainer.classList.add("ig-instructions");
    el.appendChild(insnsContainer);

    const insns = document.createElement("table");
    insns.innerHTML = `
      <colgroup>
        <col style="width: 1px">
        <col style="width: auto">
        <col style="width: auto">
      </colgroup>
    `;
    if (block.lir) {
      for (const ins of block.lir.instructions) {
        insns.appendChild(lirOpToHTML(ins));
      }
    } else {
      for (const ins of block.instructions) {
        insns.appendChild(mirOpToHTML(ins));
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
        this.selectedBlocks.clear();
      }
      this.setSelection([], block.number);
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
    svg.setAttribute("width", `${maxX}`);
    svg.setAttribute("height", `${maxY}`);
    this.container.appendChild(svg);

    this.width = maxX;
    this.height = maxY;

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
          } else if (!dst.block && dst.dstNodes[0].block?.attributes.includes("backedge")) {
            // Draw backedge arrow (skipping the topmost dummy)
            const backedge = dst.dstNodes[0].block;
            const x2 = backedge.layoutNode.pos.x + backedge.size.x;
            const y2 = backedge.layoutNode.pos.y + HEADER_ARROW_PUSHDOWN;
            const arrow = arrowToBackedge(x1, y1, x2, y2);
            svg.appendChild(arrow);
          } else if (dst.block?.attributes.includes("backedge")) {
            // Is the topmost backedge dummy; ignore since we drew past it previously.
            assert(!node.block);
          } else if (dst.block === null && dst.dstBlock.attributes.includes("backedge")) {
            if (node.block === null) {
              // Draw upward arrow between dummies
              const x2 = dst.pos.x + PORT_START;
              const y2 = dst.pos.y;
              const ym = y1 - TRACK_PADDING; // this really shouldn't matter because we should straighten all these out
              const arrow = upwardArrow(x1, y1, x2, y2, ym, false);
              svg.appendChild(arrow);
            } else {
              // Draw arrow to backedge dummy
              const x2 = dst.pos.x + PORT_START;
              const y2 = dst.pos.y;
              const ym = (y1 - node.size.y) + layerHeights[layer] + TRACK_PADDING + trackHeights[layer] / 2 + node.jointOffsets[i];
              const arrow = arrowToBackedgeDummy(x1, y1, x2, y2, ym);
              svg.appendChild(arrow);
            }
          } else {
            const x2 = dst.pos.x + PORT_START;
            const y2 = dst.pos.y;
            const ym = (y1 - node.size.y) + layerHeights[layer] + TRACK_PADDING + trackHeights[layer] / 2 + node.jointOffsets[i];
            const arrow = downwardArrow(x1, y1, x2, y2, ym, dst.block !== null);
            svg.appendChild(arrow);
          }
        }
      }
    }

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
          this.container.appendChild(el);
        }
      }
    }
  }

  private renderSelection() {
    this.container.querySelectorAll(".ig-block").forEach(blockEl => {
      const num = parseInt(must(blockEl.getAttribute("data-ig-block-number")), 10);
      blockEl.classList.toggle("ig-selected", this.selectedBlocks.has(num));
      blockEl.classList.toggle("ig-last-selected", this.lastSelectedBlock === num);
    });
  }

  hasBlock(num: number): boolean {
    return this.blocksByNum.has(num);
  }

  setSelection(blocks: number[], lastSelected?: number) {
    this.setSelectionRaw(blocks, lastSelected);
    if (lastSelected === undefined) {
      this.nav = {
        visited: [],
        currentIndex: -1,
        siblings: [],
      };
    } else {
      this.nav = {
        visited: [lastSelected],
        currentIndex: 0,
        siblings: [lastSelected],
      };
    }
  }

  private setSelectionRaw(blocks: number[], lastSelected: number | undefined) {
    this.selectedBlocks.clear();
    for (const block of [...blocks, lastSelected ?? -1]) {
      if (this.blocksByNum.has(block)) {
        this.selectedBlocks.add(block);
      }
    }
    this.lastSelectedBlock = this.blocksByNum.has(lastSelected ?? -1) ? lastSelected : undefined;
    this.renderSelection();
  }

  navigate(dir: "down" | "up" | "left" | "right") {
    const selected = this.lastSelectedBlock;

    if (dir === "down" || dir === "up") {
      // Vertical navigation
      if (selected === undefined) {
        const blocks = this.blocksInOrder;
        // No block selected; start navigation anew
        const rootBlocks = blocks.filter(b => b.predecessors.length === 0);
        const leafBlocks = blocks.filter(b => b.successors.length === 0);
        const fauxSiblings = dir === "down" ? rootBlocks : leafBlocks;
        const firstBlock = fauxSiblings[0];
        assert(firstBlock);
        this.setSelectionRaw([], firstBlock.number);
        this.nav = {
          visited: [firstBlock.number],
          currentIndex: 0,
          siblings: fauxSiblings.map(b => b.number),
        };
      } else {
        // Move to the current block's successors or predecessors,
        // respecting the visited stack
        const currentBlock = must(this.blocksByNum.get(selected));
        const nextSiblings = dir === "down" ? currentBlock.successors : currentBlock.predecessors;

        // If we have navigated to a different sibling at our current point in
        // the stack, we have gone off our prior track and start a new one.
        if (currentBlock.number !== this.nav.visited[this.nav.currentIndex]) {
          this.nav.visited = [currentBlock.number];
          this.nav.currentIndex = 0;
        }

        const nextIndex = this.nav.currentIndex + (dir === "down" ? 1 : -1);
        if (0 <= nextIndex && nextIndex < this.nav.visited.length) {
          // Move to existing block in visited stack
          this.nav.currentIndex = nextIndex;
          this.nav.siblings = nextSiblings;
        } else {
          // Push a new block onto the visited stack (either at the front or back)
          const next: number | undefined = nextSiblings[0];
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
    assert(this.lastSelectedBlock === undefined || this.nav.siblings.includes(this.lastSelectedBlock), "expected currently selected block to be in siblings array");
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
  assert(y1 + r <= ym && ym < y2 - r, `downward arrow: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r}`, true);

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
    path += `C ${x1} ${y1 + (y2 - y1) / 3} ${x2} ${y1 + 2 * (y2 - y1) / 3} ${x2} ${y2}`;
  } else {
    const dir = Math.sign(x2 - x1);
    path += `L ${x1} ${ym - r} `; // line down
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${x1 + r * dir} ${ym} `; // arc to joint
    path += `L ${x2 - r * dir} ${ym} `; // joint
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x2} ${ym + r} `; // arc to line
    path += `L ${x2} ${y2}`; // line down
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
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
  assert(y2 + r <= ym && ym <= y1 - r, `upward arrow: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r}`, true);

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
    path += `C ${x1} ${y1 + (y2 - y1) / 3} ${x2} ${y1 + 2 * (y2 - y1) / 3} ${x2} ${y2}`;
  } else {
    const dir = Math.sign(x2 - x1);
    path += `L ${x1} ${ym + r} `; // line up
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x1 + r * dir} ${ym} `; // arc to joint
    path += `L ${x2 - r * dir} ${ym} `; // joint
    path += `A ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${x2} ${ym - r} `; // arc to line
    path += `L ${x2} ${y2}`; // line up
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
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
  assert(x2 + r <= x1 && y2 + r <= y1, `to backedge: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, r = ${r}`, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    y2 += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x1} ${y2 + r}`; // vertical joint
  path += `A ${r} ${r} 0 0 0 ${x1 - r} ${y2}`; // arc to line
  path += `L ${x2} ${y2}`; // line left

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
  g.appendChild(p);

  const v = arrowhead(x2, y2, 270);
  g.appendChild(v);

  return g;
}

function arrowToBackedgeDummy(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  stroke = 1,
): SVGElement {
  const r = ARROW_RADIUS;
  assert(y1 + r <= ym && x1 <= x2 && y2 <= y1, `to backedge dummy: x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r}`, true);

  // Align stroke to pixels
  if (stroke % 2 === 1) {
    x1 += 0.5;
    x2 += 0.5;
    ym += 0.5;
  }

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x1} ${ym - r} `; // line down
  path += `A ${r} ${r} 0 0 0 ${x1 + r} ${ym}`; // arc to horizontal joint
  path += `L ${x2 - r} ${ym} `; // horizontal joint
  path += `A ${r} ${r} 0 0 0 ${x2} ${ym - r}`; // arc to line
  path += `L ${x2} ${y2}`; // line up

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
  g.appendChild(p);

  return g;
}

function loopHeaderArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  stroke = 1,
): SVGElement {
  assert(x2 < x1 && y2 === y1, `x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}`, true);

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
  p.setAttribute("stroke-width", `${stroke}`);
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
