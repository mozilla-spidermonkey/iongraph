import type { MIRBlock as _MIRBlock } from "./iongraph";
import { assert } from "./utils";
import { tweak } from "./tweak";

const DEBUG = tweak("Debug?", 0, { min: 0, max: 1 });

const LAYER_GAP = tweak("Layer Gap", 70);
const BLOCK_GAP = tweak("Block Gap", 44);

const PORT_START = tweak("Port Start", 16);
const PORT_SPACING = tweak("Port Spacing", 60);
const ARROW_RADIUS = tweak("Arrow Radius", 12);
const JOINT_SPACING = tweak("Joint Spacing", 8);
const HEADER_ARROW_PUSHDOWN = tweak("Header Arrow Pushdown", 16);
const BACKEDGE_ARROW_PUSHOUT = tweak("Backedge Arrow Pushout", 32);
const NEARLY_STRAIGHT = tweak("Nearly Straight Threshold", 30, { min: 0, max: 200 });
const NEARLY_STRAIGHT_ITERATIONS = tweak("Nearly Straight Iterations", 4, { min: 0, max: 10 });

const CONTENT_PADDING = 20;

interface Vec2 {
  x: number,
  y: number,
}

type MIRBlock = _MIRBlock & {
  // Properties added at runtime for this graph
  preds: MIRBlock[],
  succs: MIRBlock[],
  el: HTMLElement,
  size: Vec2,
  layer: number,
  loopID: number,
  layoutNode: LayoutNode, // this is set partway through the process but trying to type it as such is absolutely not worth it
}

type LoopHeader = MIRBlock & {
  loopHeight: number,
  parentLoop: LoopHeader | null,
  outgoingEdges: MIRBlock[],
  backedge: MIRBlock,
}

function isTrueLH(block: MIRBlock): block is LoopHeader {
  return block.attributes.includes("loopheader");
}

function isLH(block: MIRBlock): block is LoopHeader {
  return (block as any).loopHeight !== undefined;
}

function asTrueLH(block: MIRBlock): LoopHeader {
  if (isTrueLH(block)) {
    return block;
  }
  throw new Error("Block is not a LoopHeader");
}

function asLH(block: MIRBlock): LoopHeader {
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
}

type BlockNode = _LayoutNodeCommon & {
  block: MIRBlock,
};

type DummyNode = _LayoutNodeCommon & {
  block: null,
  dstBlock: MIRBlock,
};

export class Graph {
  container: HTMLElement;
  blocks: MIRBlock[];
  byNum: { [id: number]: MIRBlock };
  loops: LoopHeader[];

  width: number;
  height: number;

  constructor(container: HTMLElement, _blocks: _MIRBlock[]) {
    const blocks = _blocks as MIRBlock[];

    this.container = container;
    this.blocks = blocks;
    this.byNum = {};

    this.loops = []; // top-level loops; this basically forms the root of the loop tree

    this.width = 0;
    this.height = 0;

    // Initialize blocks
    for (const block of blocks) {
      this.byNum[block.number] = block;

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
      block.preds = block.predecessors.map(id => this.byNum[id]);
      block.succs = block.successors.map(id => this.byNum[id]);

      if (isTrueLH(block)) {
        const backedges = block.preds.filter(b => b.attributes.includes("backedge"));
        assert(backedges.length === 1);
        block.backedge = backedges[0];
      }
    }

    const [nodesByLayer, layerHeights] = this.layout();
    this.render(nodesByLayer, layerHeights);
  }

  private layout(): [LayoutNode[][], number[]] {
    // Make the first block a pseudo loop header.
    const firstBlock = this.blocks[0] as LoopHeader; // TODO: Determine first block(s) from graph instead of number
    firstBlock.loopHeight = 0;
    firstBlock.parentLoop = null;
    firstBlock.outgoingEdges = [];
    Object.defineProperty(firstBlock, "backedge", {
      get() {
        throw new Error("Accessed .backedge on a pseudo loop header! Don't do that.");
      },
      configurable: true,
    });

    this.findLoops(firstBlock);
    this.layer(firstBlock);
    const layoutNodesByLayer = this.makeLayoutNodesByLayer();
    const layerHeights = this.verticalize(layoutNodesByLayer);
    this.straightenEdges(layoutNodesByLayer);
    this.finagleJoints(layoutNodesByLayer);

    return [layoutNodesByLayer, layerHeights];
  }

  // Walks through the graph tracking which loop each block belongs to. As
  // each block is visited, it is assigned the current loop ID. If the
  // block has lesser loopDepth than its parent, that means it is outside
  // at least one loop, and the loop it belongs to can be looked up by loop
  // depth.
  private findLoops(block: MIRBlock, loopIDsByDepth: number[] | null = null) {
    if (loopIDsByDepth === null) {
      loopIDsByDepth = [block.number];
    }

    if (isTrueLH(block)) {
      assert(block.loopDepth === loopIDsByDepth.length);
      const parentID = loopIDsByDepth[loopIDsByDepth.length - 1];
      const parent = asLH(this.byNum[parentID]);
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

  private layer(block: MIRBlock, layer = 0) {
    if (block.attributes.includes("backedge")) {
      block.layer = block.succs[0].layer;
      return;
    }

    block.layer = Math.max(block.layer, layer);

    let loopHeader: LoopHeader | null = asLH(this.byNum[block.loopID]);
    while (loopHeader) {
      loopHeader.loopHeight = Math.max(loopHeader.loopHeight, block.layer - loopHeader.layer + 1);
      loopHeader = loopHeader.parentLoop;
    }

    for (const succ of block.succs) {
      if (succ.loopDepth < block.loopDepth) {
        // This is an outgoing edge from the current loop.
        // Track it on our current loop's header to be layered later.
        const loopHeader = asLH(this.byNum[block.loopID]);
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

  private makeLayoutNodesByLayer(): LayoutNode[][] {
    function connectNodes(from: LayoutNode, to: LayoutNode) {
      if (!from.dstNodes.includes(to)) {
        from.dstNodes.push(to);
      }
      if (!to.srcNodes.includes(from)) {
        to.srcNodes.push(from);
      }
    }

    function pruneNode(node: LayoutNode) {
      for (const dst of node.dstNodes) {
        const indexOfSelfInDst = dst.srcNodes.indexOf(node);
        assert(indexOfSelfInDst !== -1);
        dst.srcNodes.splice(indexOfSelfInDst, 1);
      }
    }

    let blocksByLayer: MIRBlock[][];
    {
      const blocksByLayerObj: { [layer: number]: MIRBlock[] } = {};
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
      dstBlock: MIRBlock,
    };

    let nodeID = 0;

    const layoutNodesByLayer: LayoutNode[][] = blocksByLayer.map(() => []);
    const activeEdges: IncompleteEdge[] = [];
    const latestDummyForBackedge = new Map<MIRBlock, DummyNode>();
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
          connectNodes(edge.src, existingDummy);
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
          };
          connectNodes(edge.src, newDummy);
          layoutNodesByLayer[layer].push(newDummy);
          dummiesByDest.set(edge.dstBlock.number, newDummy);
          dummy = newDummy;
        }

        // Update the active edge with the latest dummy.
        edge.src = dummy;
      }

      // Track which blocks will get backedge dummy nodes.
      interface LoopDummy {
        loopID: number,
        block: MIRBlock,
      }
      const loopDummies: LoopDummy[] = [];
      const loopHeaders = new Set<number>();
      for (const block of blocks) {
        if (isTrueLH(block)) {
          loopHeaders.add(block.number);
        }

        let currentLoopHeader = asLH(this.byNum[block.loopID]);
        while (isTrueLH(currentLoopHeader)) {
          const existing = loopDummies.find(d => d.loopID === currentLoopHeader.number);
          if (existing) {
            // We have seen this loop before but have a new rightmost block for
            // it. Update which block should get the dummy.
            existing.block = block;
          } else {
            if (!loopHeaders.has(currentLoopHeader.number)) {
              // This loop has not been seen before, and it didn't start on
              // this layer, so track it.
              loopDummies.push({ loopID: currentLoopHeader.number, block: block });
            }
          }

          const parentLoop = currentLoopHeader.parentLoop;
          if (!parentLoop) {
            break;
          }
          currentLoopHeader = parentLoop;
        }
      }

      // Create real nodes for each block on the layer.
      const backedgeEdges: [MIRBlock, MIRBlock][] = [];
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
        };
        for (const edge of terminatingEdges) {
          if (edge.dstBlock === block) {
            connectNodes(edge.src, node);
          }
        }
        layoutNodesByLayer[layer].push(node);
        block.layoutNode = node;

        // Create dummy nodes for backedges
        for (const loopDummy of loopDummies.filter(d => d.block === block)) {
          const backedge = asLH(this.byNum[loopDummy.loopID]).backedge;
          const backedgeDummy: DummyNode = {
            id: nodeID++,
            pos: { x: CONTENT_PADDING, y: CONTENT_PADDING },
            size: { x: 0, y: 0 },
            block: null,
            srcNodes: [],
            dstNodes: [],
            dstBlock: backedge,
            jointOffsets: [],
          };
          connectNodes(backedgeDummy, latestDummyForBackedge.get(backedge) ?? backedge.layoutNode);
          layoutNodesByLayer[layer].push(backedgeDummy);
          latestDummyForBackedge.set(backedge, backedgeDummy);
        }

        if (block.attributes.includes("backedge")) {
          // Connect backedge to loop header immediately
          connectNodes(block.layoutNode, block.succs[0].layoutNode);
        } else {
          for (const succ of block.succs) {
            if (succ.attributes.includes("backedge")) {
              // Track this edge to be added after all the backedge dummies on
              // this row have been added.
              backedgeEdges.push([block, succ]);
            } else {
              activeEdges.push({ src: node, dstBlock: succ });
            }
          }
        }
      }
      for (const [block, backedge] of backedgeEdges) {
        const backedgeDummy = latestDummyForBackedge.get(backedge);
        assert(backedgeDummy);
        connectNodes(block.layoutNode, backedgeDummy);
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

    return layoutNodesByLayer;
  }

  private verticalize(layoutNodesByLayer: LayoutNode[][]): number[] {
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
      nextLayerY += layerHeight + LAYER_GAP;
    }

    return layerHeights;
  }

  private straightenEdges(layoutNodesByLayer: LayoutNode[][]) {
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

    // Push nodes to the right so they fit inside their loop
    const pushIntoLoops = () => {
      for (const nodes of layoutNodesByLayer) {
        for (const node of nodes) {
          if (node.block === null) {
            continue;
          }

          const loopHeader = node.block.loopID !== null ? asLH(this.byNum[node.block.loopID]) : null;
          if (loopHeader) {
            const loopHeaderNode = loopHeader.layoutNode;
            node.pos.x = Math.max(node.pos.x, loopHeaderNode.pos.x);
          }
        }
      }
    };

    const straightenBackedgeDummies = () => {
      // Track max position of backedge dummies
      const backedgeLinePositions = new Map<MIRBlock, number>();
      for (const dummy of backedgeDummies(layoutNodesByLayer)) {
        const backedge = dummy.dstBlock;
        let desiredX = dummy.pos.x;
        if (dummy.dstNodes[0].block) {
          // Direct input to backedge
          const bn = backedge.layoutNode;
          desiredX = bn.pos.x + bn.size.x + BACKEDGE_ARROW_PUSHOUT;
        }
        backedgeLinePositions.set(backedge, Math.max(backedgeLinePositions.get(backedge) ?? 0, desiredX));
      }

      // Apply positions to backedge dummies
      for (const dummy of backedgeDummies(layoutNodesByLayer)) {
        const backedge = dummy.dstBlock;
        const x = backedgeLinePositions.get(backedge);
        assert(x, `no position for backedge ${backedge.number}`);
        dummy.pos.x = x;
      }
    };

    // Walk down the layers, pulling children to the right to line up with
    // their parents.
    const straightenChildren = () => {
      for (let layer = 0; layer < layoutNodesByLayer.length - 1; layer++) {
        const nodes = layoutNodesByLayer[layer];

        // Push nodes to the right if they are too close together
        pushNeighbors(nodes);

        // Walk this layer and the next, shifting nodes to the right to line
        // up the edges.
        let nextCursor = 0;
        for (const node of nodes) {
          for (const [srcPort, dst] of node.dstNodes.entries()) {
            let toShift: LayoutNode | null = null;
            for (let i = nextCursor; i < layoutNodesByLayer[layer + 1].length; i++) {
              const nextNode = layoutNodesByLayer[layer + 1][i];
              if (nextNode.srcNodes[0] === node) {
                toShift = nextNode;
                nextCursor = i + 1;
                break;
              }
            }

            if (toShift) {
              const srcPortOffset = PORT_START + PORT_SPACING * srcPort;
              const dstPortOffset = PORT_START;
              toShift.pos.x = Math.max(toShift.pos.x, node.pos.x + srcPortOffset - dstPortOffset);
            }
          }
        }
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
              // Only do this to dummies (for now?)
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

    // Walk down the layers, straightening out edges that are nearly straight.
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
            // Only do this to dummies (for now?)
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

    straightenChildren();
    pushIntoLoops();
    straightenBackedgeDummies();
    for (let i = 0; i < NEARLY_STRAIGHT_ITERATIONS; i++) {
      straightenNearlyStraightEdgesUp();
      straightenNearlyStraightEdgesDown();
    }
    straightenBackedgeDummies();
    for (const nodes of layoutNodesByLayer) {
      pushNeighbors(nodes);
    }
  }

  private finagleJoints(layoutNodesByLayer: LayoutNode[][]) {
    interface Joint {
      x1: number,
      x2: number,
      src: LayoutNode,
      srcPort: number,
      dst: LayoutNode,
    }

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
            const overlaps = ar > bl && al < br;
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
    }
  }

  private renderBlock(block: MIRBlock): HTMLElement {
    const el = document.createElement("div");
    el.classList.add("ig-block");
    let html = "";
    let desc = "";
    if (block.attributes.includes("loopheader")) {
      desc = " (loop header)";
    } else if (block.attributes.includes("backedge")) {
      desc = " (backedge)";
    }
    html += `<h2>Block ${block.number}${desc}</h2>`;
    html += `<div class="instructions">`;
    for (const ins of block.instructions) {
      html += `<div>${ins.id} ${ins.opcode}</div>`;
    }
    html += "</div>";
    el.innerHTML = html;
    this.container.appendChild(el);

    el.style.width = `${el.clientWidth + 10}px`; // fudge factor because text sucks
    el.style.height = `${el.clientHeight}px`;

    return el;
  }

  private render(nodesByLayer: LayoutNode[][], layerHeights: number[]) {
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
          } else if (dst.block?.attributes.includes("backedge")) {
            // Draw backedge arrow
            const backedge = dst.block;
            const x2 = backedge.layoutNode.pos.x + backedge.size.x;
            const y2 = backedge.layoutNode.pos.y + HEADER_ARROW_PUSHDOWN;
            const ym = (y1 - node.size.y) + layerHeights[layer] + LAYER_GAP / 2;
            const arrow = arrowToBackedge(x1, y1, x2, y2);
            svg.appendChild(arrow);
          } else if (dst.block === null && dst.dstBlock.attributes.includes("backedge")) {
            if (node.block === null) {
              // Draw upward arrow between dummies
              const x2 = dst.pos.x + PORT_START;
              const y2 = dst.pos.y;
              const ym = y1 - LAYER_GAP / 2; // this really shouldn't matter because we should straighten all these out
              const arrow = upwardArrow(x1, y1, x2, y2, ym, false);
              svg.appendChild(arrow);
            } else {
              // Draw arrow to backedge dummy
              const x2 = dst.pos.x + PORT_START;
              const y2 = dst.pos.y;
              const ym = (y1 - node.size.y) + layerHeights[layer] + LAYER_GAP / 2 + node.jointOffsets[i];
              const arrow = arrowToBackedgeDummy(x1, y1, x2, y2, ym);
              svg.appendChild(arrow);
            }
          } else {
            const x2 = dst.pos.x + PORT_START;
            const y2 = dst.pos.y;
            const ym = (y1 - node.size.y) + layerHeights[layer] + LAYER_GAP / 2 + node.jointOffsets[i];
            const arrow = downwardArrow(x1, y1, x2, y2, ym, dst.block !== null);
            // arrow.setAttribute("data-edge", `${block.number} -> ${succ.number}`);
            svg.appendChild(arrow);
          }
        }
      }
    }

    // Render dummy nodes
    if (+DEBUG) {
      for (const nodes of nodesByLayer) {
        for (const node of nodes) {
          const el = document.createElement("div");
          el.innerHTML = `${node.id}<br>&lt;- ${node.srcNodes.map(n => n.id)}<br>-&gt; ${node.dstNodes.map(n => n.id)}`;
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
