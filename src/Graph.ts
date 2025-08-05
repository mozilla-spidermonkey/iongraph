import type { MIRBlock as _MIRBlock } from "./iongraph";

const LAYER_GAP = 36;
const BLOCK_GAP = 24;
// const LOOP_INDENT = 36;
const LOOP_INDENT = 0; // This is not really useful because edge straightening will make everything look like the child of a loop.
const BACKEDGE_DEDENT = 36;
const BACKEDGE_PUSHDOWN = 48;
const HEADER_ARROW_PUSHDOWN = 16;

const PORT_START = 16;
const PORT_SPACING = 40;
const ARROW_RADIUS = 10;

interface Vec2 {
  x: number,
  y: number,
}

type MIRBlock = _MIRBlock & {
  // Properties added at runtime for this graph
  contentSize: Vec2,
  pos: Vec2,
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

interface LayoutNode {
  pos: Vec2,
  size: Vec2,
  blockOffset: Vec2,
  indent: number,
  predecessors: number[],
  successors: number[],
  block: number | null,
}

export class Graph {
  container: HTMLElement;
  blocks: MIRBlock[];
  byNum: { [id: number]: MIRBlock };
  els: { [blockID: number]: HTMLElement };
  loops: never[];

  constructor(container: HTMLElement, _blocks: _MIRBlock[]) {
    const blocks = _blocks as MIRBlock[];

    this.container = container;
    this.blocks = blocks;
    this.byNum = {};
    this.els = {};

    this.loops = []; // top-level loops; this basically forms the root of the loop tree

    for (const block of blocks) {
      this.byNum[block.number] = block;
      // if (block.successors.length === 2) {
      //   // HACK: Swap the true and false branches of tests
      //   const tmp = block.successors[0];
      //   block.successors[0] = block.successors[1];
      //   block.successors[1] = tmp;
      // }

      const el = document.createElement("div");
      el.classList.add("block");
      let html = "";
      let desc = "";
      if (block.attributes.includes("loopheader")) {
        desc = " (loop header)";
      } else if (block.attributes.includes("backedge")) {
        desc = " (backedge)";
      }
      // desc += ` (LD=${block.loopDepth})`;
      html += `<h2>Block ${block.number}${desc}</h2>`;
      html += `<div class="instructions">`;
      for (const ins of block.instructions) {
        html += `<div>${ins.id} ${ins.opcode}</div>`;
      }
      html += "</div>";
      el.innerHTML = html;
      container.appendChild(el);
      this.els[block.number] = el;

      block.contentSize = {
        x: el.clientWidth,
        y: el.clientHeight,
      };
      block.pos = { x: 0, y: 0 }; // Not used for layout

      block.layer = -1;
      block.loopID = 0;
      if (block.attributes.includes("loopheader")) {
        const lh = block as LoopHeader;
        lh.loopHeight = 0;
        lh.parentLoop = null;
        lh.outgoingEdges = [];
      }

      // Lock the element to its initially rendered size plus fudge factor because text sucks
      el.style.width = `${block.contentSize.x + 10}px`;
      el.style.height = `${block.contentSize.y}px`;
    }

    // After putting all blocks in our map, assign backedges to loops.
    for (const block of blocks) {
      if (isTrueLH(block)) {
        const backedges = block.predecessors
          .map(p => this.byNum[p])
          .filter(b => b.attributes.includes("backedge"));
        assert(backedges.length === 1);
        block.backedge = backedges[0];
      }
    }

    const [nodesByLayer, layerHeights] = this.layout();
    this.render(nodesByLayer, layerHeights);
  }

  predecessorBlocks(block: MIRBlock) {
    return block.predecessors.map(id => this.byNum[id]);
  }

  successorBlocks(block: MIRBlock) {
    return block.successors.map(id => this.byNum[id]);
  }

  layout(): [LayoutNode[][], number[]] {
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
    const [layoutNodes, layoutNodesByLayer] = this.makeLayoutNodes();
    const layerHeights = this.verticalize(layoutNodesByLayer);
    this.straightenEdges(layoutNodesByLayer);

    // Temporary: apply layout node positions to blocks
    for (const nodes of layoutNodesByLayer) {
      for (const node of nodes) {
        if (node.block !== null) {
          this.byNum[node.block].pos = node.pos;
        }
      }
    }

    return [layoutNodesByLayer, layerHeights];
  }

  // Walks through the graph tracking which loop each block belongs to. As
  // each block is visited, it is assigned the current loop ID. If the
  // block has lesser loopDepth than its parent, that means it is outside
  // at least one loop, and the loop it belongs to can be looked up by loop
  // depth.
  findLoops(block: MIRBlock, loopIDsByDepth: number[] | null = null) {
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
      for (const succ of this.successorBlocks(block)) {
        this.findLoops(succ, loopIDsByDepth);
      }
    }
  }

  layer(block: MIRBlock, layer = 0) {
    if (block.attributes.includes("backedge")) {
      block.layer = this.successorBlocks(block)[0].layer;
      return;
    }

    block.layer = Math.max(block.layer, layer);

    let loopHeader: LoopHeader | null = asLH(this.byNum[block.loopID]);
    while (loopHeader) {
      loopHeader.loopHeight = Math.max(loopHeader.loopHeight, block.layer - loopHeader.layer + 1);
      loopHeader = loopHeader.parentLoop;
    }

    for (const succ of this.successorBlocks(block)) {
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

  makeLayoutNodes(): [LayoutNode[], LayoutNode[][]] {
    const unlayeredBlocks = [];
    let blocksByLayer;
    {
      const blocksByLayerObj: { [layer: number]: MIRBlock[] } = {};
      for (const block of this.blocks) {
        if (block.attributes.includes("backedge")) {
          unlayeredBlocks.push(block);
          continue;
        }

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

    const layoutNodes = [];
    const layoutNodesByLayer: LayoutNode[][] = blocksByLayer.map(() => []);
    const activeEdges = [];
    for (const [layer, blocks] of blocksByLayer.entries()) {
      // Delete any active edges that terminate at this layer, since we do
      // not want to make any dummy nodes for them.
      for (const block of blocks) {
        for (let i = activeEdges.length - 1; i >= 0; i--) {
          const [from, to] = activeEdges[i];
          if (to === block.number) {
            activeEdges.splice(i, 1);
          }
        }
      }

      // Create dummy nodes for active edges.
      for (const edge of activeEdges) {
        const [from, to] = edge;
        const node: LayoutNode = {
          pos: { x: 0, y: 0 },
          size: { x: 0, y: 0 },
          blockOffset: { x: 0, y: 0 },
          indent: 0,
          predecessors: [from],
          successors: [to],
          block: null,
        };
        layoutNodes.push(node);
        layoutNodesByLayer[layer].push(node);
      }

      // Create real nodes for each block on the layer.
      for (const block of blocks) {
        const node: LayoutNode = {
          pos: { x: 0, y: 0 },
          size: block.contentSize,
          blockOffset: { x: 0, y: 0 },
          indent: 0,
          predecessors: block.predecessors,
          successors: block.successors,
          block: block.number,
        };
        if (isTrueLH(block)) {
          node.size = {
            x: block.backedge.contentSize.x + BACKEDGE_DEDENT + node.size.x,
            y: Math.max(node.size.y, BACKEDGE_PUSHDOWN + block.backedge.contentSize.y),
          };
          node.blockOffset.x = block.backedge.contentSize.x + BACKEDGE_DEDENT;
          node.indent = LOOP_INDENT;
        }

        layoutNodes.push(node);
        layoutNodesByLayer[layer].push(node);
        block.layoutNode = node;

        for (const succ of this.successorBlocks(block)) {
          if (succ.attributes.includes("backedge")) {
            continue;
          }
          activeEdges.push([block.number, succ.number]);
        }
      }

      // Create nodes for any blocks that weren't assigned to layers.
      for (const block of unlayeredBlocks) {
        const node = {
          pos: { x: 0, y: 0 },
          size: block.contentSize,
          blockOffset: { x: 0, y: 0 },
          indent: 0,
          predecessors: block.predecessors,
          successors: block.successors,
          block: block.number,
        };
        layoutNodes.push(node);
        block.layoutNode = node;
      }
    }

    return [layoutNodes, layoutNodesByLayer];
  }

  verticalize(layoutNodesByLayer: LayoutNode[][]): number[] {
    const layerHeights: number[] = new Array(layoutNodesByLayer.length);

    let nextLayerY = 0;
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

  straightenEdges(layoutNodesByLayer: LayoutNode[][]) {
    function pushNeighbors(nodes: LayoutNode[]) {
      for (let i = 0; i < nodes.length - 1; i++) {
        const node = nodes[i];
        const neighbor = nodes[i + 1];

        // Special case: dummy nodes with the same destination should coalesce
        if (
          node.block === null && neighbor.block === null
          && node.successors[0] === neighbor.successors[0] // yes, we always want actual successors
        ) {
          neighbor.pos.x = node.pos.x;
          continue;
        }

        const nodeRightPlusPadding = node.pos.x + node.size.x + BLOCK_GAP;
        neighbor.pos.x = Math.max(neighbor.pos.x, nodeRightPlusPadding);
      }
    }

    // Walk down the layers, straightening things out
    for (let layer = 0; layer < layoutNodesByLayer.length - 1; layer++) {
      const nodes = layoutNodesByLayer[layer];

      // Push nodes to the right so they fit inside their loop
      for (const node of nodes) {
        if (node.block === null) {
          continue;
        }

        const block = this.byNum[node.block];
        const loopHeader = block.loopID !== null ? asLH(this.byNum[block.loopID]) : null;
        if (loopHeader) {
          const loopHeaderNode = loopHeader.layoutNode;
          node.pos.x = Math.max(node.pos.x, loopHeaderNode.pos.x + loopHeaderNode.blockOffset.x + loopHeaderNode.indent - node.blockOffset.x);
        }
      }

      // Push nodes to the right if they are too close together
      pushNeighbors(nodes);

      // Walk this layer and the next, shifting nodes to the right to line
      // up the edges.
      let nextCursor = 0;
      for (const node of nodes) {
        for (const [srcPort, succNum] of node.successors.entries()) {
          let toShift = null;
          for (let i = nextCursor; i < layoutNodesByLayer[layer + 1].length; i++) {
            const nextNode = layoutNodesByLayer[layer + 1][i];
            if (
              (nextNode.block === null && nextNode.successors[0] === succNum && nextNode.predecessors[0] === (node.block === null ? node.predecessors[0] : node.block))
              || (nextNode.block !== null && this.byNum[nextNode.block].number === succNum)
            ) {
              toShift = nextNode;
              nextCursor = i + 1;
            }
          }

          if (toShift) {
            const srcPortOffset = node.blockOffset.x + (node.block === null ? 0 : PORT_START + PORT_SPACING * srcPort);
            const dstPortOffset = toShift.blockOffset.x + (toShift.block === null ? 0 : PORT_START);
            toShift.pos.x = Math.max(toShift.pos.x, node.pos.x + srcPortOffset - dstPortOffset);
          }
        }
      }
    }

    // Walk back up the layers, doing a very limited shift-right
    for (let layer = layoutNodesByLayer.length - 1; layer >= 0; layer--) {
      const nodes = layoutNodesByLayer[layer];

      for (const node of nodes) {
        const predecessorsMinusBackedges = node.predecessors.filter(p => !this.byNum[p].attributes.includes("backedge"));
        if (predecessorsMinusBackedges.length !== 1) {
          continue;
        }

        const predNum = predecessorsMinusBackedges[0];
        for (let i = 0; i < layoutNodesByLayer[layer - 1].length; i++) {
          const prevNode = layoutNodesByLayer[layer - 1][i];
          if (prevNode.block !== null && this.byNum[prevNode.block].number === predNum) {
            const prevBlock = this.byNum[prevNode.block];
            if (prevBlock.successors.length === 1) {
              const srcPortOffset = prevNode.blockOffset.x + (prevNode.block === null ? 0 : PORT_START);
              const dstPortOffset = node.blockOffset.x + (node.block === null ? 0 : PORT_START);
              prevNode.pos.x = Math.max(prevNode.pos.x, node.pos.x + dstPortOffset - srcPortOffset);
            }
          }
        }
      }

      // Push nodes to the right if they are too close together
      pushNeighbors(nodes);
    }
  }

  render(nodesByLayer: LayoutNode[][], layerHeights: number[]) {
    // Position blocks according to layout
    for (const nodes of nodesByLayer) {
      for (const node of nodes) {
        if (node.block !== null) {
          const block = this.byNum[node.block];
          block.pos = node.pos;

          const el = this.els[block.number];
          el.style.left = `${node.pos.x + node.blockOffset.x}px`;
          el.style.top = `${node.pos.y + node.blockOffset.y}px`;

          if (isTrueLH(block)) {
            const backedgeNode = block.backedge.layoutNode;
            backedgeNode.pos = {
              x: node.pos.x,
              y: node.pos.y + BACKEDGE_PUSHDOWN,
            };

            const backedgeEl = this.els[block.backedge.number];
            backedgeEl.style.left = `${node.pos.x}px`;
            backedgeEl.style.top = `${node.pos.y + BACKEDGE_PUSHDOWN}px`;
          }
        }
      }
    }

    // Optional: render dummy nodes
    if (false) {
      for (const nodes of nodesByLayer) {
        for (const node of nodes) {
          if (node.block === null) {
            const el = document.createElement("div");
            el.classList.add("dummy");
            el.innerText = `${node.predecessors[0]} -> ${node.successors[0]}`;
            el.style.left = `${node.pos.x}px`;
            el.style.top = `${node.pos.y}px`;
            this.container.appendChild(el);
          }
        }
      }
    }

    // Create and size the SVG
    let maxX = 0, maxY = 0;
    for (const block of this.blocks) {
      maxX = Math.max(maxX, block.pos.x + block.contentSize.x + 36);
      maxY = Math.max(maxY, block.pos.y + block.contentSize.y + 36);
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", `${maxX}`);
    svg.setAttribute("height", `${maxY + LAYER_GAP}`);
    this.container.appendChild(svg);

    // Render arrows
    for (let layer = 0; layer < nodesByLayer.length; layer++) {
      const nodes = nodesByLayer[layer];
      for (const node of nodes) {
        for (const [i, succ] of node.successors.entries()) {
          const x1 = node.pos.x + node.blockOffset.x + (node.block !== null ? PORT_START + PORT_SPACING * i : 0);
          const y1 = node.pos.y + node.blockOffset.y + (node.block !== null ? this.byNum[node.block].contentSize.y : 0);

          if (this.byNum[succ].attributes.includes("backedge")) {
            // Draw backedge arrow
            const backedge = this.byNum[succ];
            const backedgeNode = backedge.layoutNode;
            {
              const x2 = backedgeNode.pos.x + backedgeNode.blockOffset.x + PORT_START;
              const y2 = backedgeNode.pos.y + backedgeNode.blockOffset.y + backedgeNode.size.y;
              const ym = (y1 - node.size.y) + layerHeights[layer] + LAYER_GAP / 2;
              const arrow = backedgeArrow(x1, y1, x2, y2, ym, ARROW_RADIUS);
              svg.appendChild(arrow);
            }

            // Draw loop header arrow
            const header = this.byNum[backedge.successors[0]];
            const headerNode = header.layoutNode;
            {
              const x1 = backedgeNode.pos.x + backedgeNode.blockOffset.x + PORT_START;
              const y1 = backedgeNode.pos.y + backedgeNode.blockOffset.y;
              const x2 = headerNode.pos.x + headerNode.blockOffset.x;
              const y2 = headerNode.pos.y + headerNode.blockOffset.y + HEADER_ARROW_PUSHDOWN;
              const arrow = loopHeaderArrow(x1, y1, x2, y2, ARROW_RADIUS);
              svg.appendChild(arrow);
            }

            continue;
          }

          const destNode = nodesByLayer[layer + 1].find(n => (
            (n.block !== null && this.byNum[n.block].number === succ)
            || (n.block === null && n.successors[0] === succ && n.predecessors[0] === (node.block === null ? node.predecessors[0] : node.block)) // TODO: find dummy nodes
          ));
          assert(destNode);

          const x2 = destNode.pos.x + destNode.blockOffset.x + (destNode.block !== null ? PORT_START : 0);
          const y2 = destNode.pos.y + destNode.blockOffset.y;
          const ym = (y1 - node.size.y) + layerHeights[layer] + LAYER_GAP / 2;
          // const ym = node.block === null ? (y2 - LAYER_GAP / 2) : (y1 + LAYER_GAP / 2);
          const arrow = downwardArrow(x1, y1, x2, y2, ym, ARROW_RADIUS, destNode.block !== null);
          // arrow.setAttribute("data-edge", `${block.number} -> ${succ.number}`);
          svg.appendChild(arrow);
        }
      }
    }

    if (false) {
      // Render arrows
      for (const block of this.blocks) {
        if (block.attributes.includes("backedge")) {
          continue; // TODO: re-enable after backedges are positioned
          const header = this.byNum[block.successors[0]];
          const x1 = block.pos.x + PORT_START;
          const y1 = block.pos.y;
          const x2 = header.pos.x;
          const y2 = header.pos.y + PORT_START;
          const arrow = loopHeaderArrow(x1, y1, x2, y2, ARROW_RADIUS);
          arrow.setAttribute("data-edge", `${block.number} -> ${header.number}`);
          svg.appendChild(arrow);
        } else {
          const successors = block.successors.map(id => this.byNum[id]);
          for (const [i, succ] of successors.entries()) {
            const x1 = block.pos.x + PORT_START + PORT_SPACING * i;
            const y1 = block.pos.y + block.contentSize.y;

            if (succ.attributes.includes("backedge")) {
              continue; // TODO: re-enable after backedges are positioned
              const x2 = succ.pos.x + PORT_START;
              const y2 = succ.pos.y + succ.contentSize.y;
              const ym = y1 + LAYER_GAP / 2;
              const arrow = backedgeArrow(x1, y1, x2, y2, ym, ARROW_RADIUS);
              arrow.setAttribute("data-edge", `${block.number} -> ${succ.number}`);
              svg.appendChild(arrow);
            } else {
              const x2 = succ.pos.x + PORT_START;
              const y2 = succ.pos.y;
              const ym = y1 + LAYER_GAP / 2;
              // const ym = y2 - GAP_ABOVE_CHILDREN / 2;
              const arrow = downwardArrow(x1, y1, x2, y2, ym, ARROW_RADIUS);
              arrow.setAttribute("data-edge", `${block.number} -> ${succ.number}`);
              svg.appendChild(arrow);
            }
          }
        }
      }
    }
  }
}

function downwardArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  r: number,
  doArrowhead = true,
  stroke = 1,
) {
  assert(y1 + r <= ym && ym < y2 - r, `x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r}`);

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

function backedgeArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  ym: number,
  r: number,
  stroke = 1,
) {
  assert(y1 + r <= ym && y2 + r <= ym, `x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, ym = ${ym}, r = ${r}`);

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x1} ${ym - r} `; // line down
  path += `A ${r} ${r} 0 0 1 ${x1 - r} ${ym}`; // arc to joint
  path += `L ${x2 + r} ${ym} `; // joint
  path += `A ${r} ${r} 0 0 1 ${x2} ${ym - r}`; // arc to line
  path += `L ${x2} ${y2}`; // line up

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
  g.appendChild(p);

  const v = arrowhead(x2, y2, 0);
  g.appendChild(v);

  return g;
}

function loopHeaderArrow(
  x1: number, y1: number,
  x2: number, y2: number,
  r: number,
  stroke = 1,
) {
  assert(x1 + r <= x2 && y1 - r >= y2, `x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2}, r = ${r}`);

  let path = "";
  path += `M ${x1} ${y1} `; // move to start
  path += `L ${x1} ${y2 + r} `; // line up
  path += `A ${r} ${r} 0 0 1 ${x1 + r} ${y2}`; // arc to line
  path += `L ${x2} ${y2} `; // line right

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "black");
  p.setAttribute("stroke-width", `${stroke}`);
  g.appendChild(p);

  const v = arrowhead(x2, y2, 90);
  g.appendChild(v);

  return g;
}

function arrowhead(x: number, y: number, rot: number, size = 5) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", `M 0 0 L ${-size} ${size * 1.5} L ${size} ${size * 1.5} Z`);
  p.setAttribute("transform", `translate(${x}, ${y}) rotate(${rot})`);
  return p;
}

type Falsy = null | undefined | false | 0 | -0 | 0n | "";

function assert<T>(cond: T | Falsy, msg?: string): asserts cond is T {
  if (!cond) {
    throw new Error(msg ?? "Assertion failed");
  }
}
