"""Layout engine for patent diagrams."""

import math
from dataclasses import dataclass
from typing import Optional

from .models import (
    Diagram,
    Edge,
    Group,
    GroupLayout,
    LayoutResult,
    Node,
    NodeData,
    NodeType,
    PhysicalRow,
    RowType,
    Vec2,
)


@dataclass
class PageConfig:
    """US Letter page configuration with fixed spacing."""

    # Page dimensions (PostScript points, 72 DPI)
    LETTER_WIDTH_PT: float = 612  # 8.5 inches
    LETTER_HEIGHT_PT: float = 792  # 11 inches
    MARGIN_PT: float = 36  # 0.5 inch margins

    USABLE_WIDTH: float = 540  # 7.5 inches
    USABLE_HEIGHT: float = 720  # 10 inches

    # Typography (FIXED - never change)
    FONT_SIZE: float = 12.0
    LINE_HEIGHT: float = 15.0  # 1.25 × font size
    CHAR_WIDTH: float = 7.2  # Monospace character width

    # Spacing (FIXED - comfortable spacing)
    BLOCK_GAP_X: float = 40.0  # Horizontal gap between nodes
    BLOCK_GAP_Y: float = 50.0  # Vertical gap between layers
    ROW_GAP_Y: float = 30.0  # Gap between reflowed rows (smaller)

    # Block constraints
    MIN_BLOCK_WIDTH: float = 80.0
    MAX_BLOCK_WIDTH: float = 200.0
    BLOCK_PADDING: float = 10.0

    # Group settings
    GROUP_PADDING: float = 20.0
    GROUP_LABEL_HEIGHT: float = 30.0

    # Edge rendering
    EDGE_RADIUS: float = 8.0  # Corner radius for rounded edges


def calculate_text_size(text: str, font_size: float = 12.0) -> Vec2:
    """
    Calculate text bounding box in points.
    Uses fixed metrics for monospace font.
    """
    lines = text.split("\n")

    # Width = longest line × character width
    max_chars = max(len(line) for line in lines) if lines else 0
    width = max_chars * (font_size * 0.6)  # 0.6 is monospace ratio

    # Height = number of lines × line height
    height = len(lines) * (font_size * 1.25)

    return Vec2(width, height)


def wrap_text_if_needed(text: str, max_width: float, font_size: float) -> str:
    """Wrap text to fit within max_width."""
    if "\n" in text:
        return text  # Already has line breaks

    char_width = font_size * 0.6
    max_chars = int(max_width / char_width)

    if len(text) <= max_chars:
        return text

    # Simple word wrapping
    words = text.split()
    lines = []
    current_line = []
    current_length = 0

    for word in words:
        word_length = len(word)

        if current_length + word_length + 1 <= max_chars:
            current_line.append(word)
            current_length += word_length + 1
        else:
            if current_line:
                lines.append(" ".join(current_line))
            current_line = [word]
            current_length = word_length

    if current_line:
        lines.append(" ".join(current_line))

    return "\n".join(lines)


def calculate_block_size(node: Node, config: PageConfig) -> Vec2:
    """
    Calculate block size with padding.
    Wraps text if too wide.
    """
    # Auto-wrap long labels
    label = wrap_text_if_needed(
        node.label, config.MAX_BLOCK_WIDTH - 2 * config.BLOCK_PADDING, config.FONT_SIZE
    )
    node.label = label  # Update node with wrapped text

    text_size = calculate_text_size(label, config.FONT_SIZE)

    # Add padding
    width = text_size.x + 2 * config.BLOCK_PADDING
    height = text_size.y + 2 * config.BLOCK_PADDING

    # Enforce min/max
    width = max(config.MIN_BLOCK_WIDTH, min(width, config.MAX_BLOCK_WIDTH))

    # Decision nodes are square (diamond inscribed)
    if node.type == NodeType.DECISION:
        size = max(width, height) * 1.2  # 20% larger for diamond
        width = height = size

    return Vec2(width, height)


class LayoutEngine:
    """Layout engine for patent diagrams."""

    def __init__(self, diagram: Diagram, config: PageConfig):
        self.diagram = diagram
        self.config = config
        self.nodes_by_id: dict[str, NodeData] = {}
        self.groups_by_id: dict[str, GroupLayout] = {}

    def _assign_logical_layers(self) -> list[list[Node]]:
        """
        Assign nodes to logical layers using topological sort.

        Algorithm:
        1. Start with nodes that have no incoming edges (sources)
        2. Assign them to layer 0
        3. Process nodes whose predecessors are all assigned
        4. Continue until all nodes assigned
        """
        # Build predecessor count
        in_degree = {node.id: 0 for node in self.diagram.nodes}
        adjacency = {node.id: [] for node in self.diagram.nodes}

        for edge in self.diagram.edges:
            # Skip edges involving groups for now
            if edge.from_ in in_degree and edge.to in in_degree:
                in_degree[edge.to] += 1
                adjacency[edge.from_].append(edge.to)

        # Find source nodes (no incoming edges)
        current_layer = [nid for nid, deg in in_degree.items() if deg == 0]

        if not current_layer:
            # No sources - graph has cycles, use arbitrary start
            current_layer = [self.diagram.nodes[0].id]

        layers = []
        assigned = set()
        layer_map = {}  # node_id -> layer_number

        layer_num = 0
        while current_layer:
            layers.append([self.diagram.nodes_by_id[nid] for nid in current_layer])

            for nid in current_layer:
                assigned.add(nid)
                layer_map[nid] = layer_num

            # Find next layer: nodes whose predecessors are all assigned
            next_layer = []
            for nid in current_layer:
                for successor in adjacency[nid]:
                    if successor not in assigned:
                        # Check if all predecessors assigned
                        all_preds_assigned = True
                        for edge in self.diagram.edges:
                            if edge.to == successor and edge.from_ in in_degree:
                                if edge.from_ not in assigned:
                                    all_preds_assigned = False
                                    break

                        if all_preds_assigned and successor not in next_layer:
                            next_layer.append(successor)

            current_layer = next_layer
            layer_num += 1

        # Handle any unassigned nodes (disconnected components)
        unassigned = [n.id for n in self.diagram.nodes if n.id not in assigned]
        if unassigned:
            layers.append([self.diagram.nodes_by_id[nid] for nid in unassigned])

        return layers

    def _calculate_layer_width(self, nodes: list[Node]) -> float:
        """Calculate total width if all nodes placed horizontally."""
        if not nodes:
            return 0

        total_width = sum(self.nodes_by_id[n.id].size.x for n in nodes)
        gap_width = (len(nodes) - 1) * self.config.BLOCK_GAP_X

        return total_width + gap_width

    def _split_layer_balanced(self, layer: list[Node], layer_idx: int) -> list[PhysicalRow]:
        """
        Split layer into balanced rows.

        Strategy: Distribute nodes evenly across minimum number of rows.
        """
        total_width = self._calculate_layer_width(layer)
        num_rows_needed = math.ceil(total_width / self.config.USABLE_WIDTH)
        target_width_per_row = total_width / num_rows_needed

        rows = []
        current_row_nodes = []
        current_width = 0.0

        for node in layer:
            node_data = self.nodes_by_id[node.id]
            node_width = node_data.size.x
            gap = self.config.BLOCK_GAP_X if current_row_nodes else 0

            # Check if adding this node would exceed target
            if current_width + gap + node_width > target_width_per_row and current_row_nodes:
                # Save current row and start new one
                rows.append(
                    PhysicalRow(
                        nodes=current_row_nodes,
                        logical_layer=layer_idx,
                        row_type=RowType.SPLIT_LAYER,
                    )
                )
                current_row_nodes = [node]
                current_width = node_width
            else:
                current_row_nodes.append(node)
                current_width += gap + node_width

        # Add final row
        if current_row_nodes:
            rows.append(
                PhysicalRow(
                    nodes=current_row_nodes,
                    logical_layer=layer_idx,
                    row_type=RowType.SPLIT_LAYER,
                )
            )

        return rows

    def _reflow_layers(self, logical_layers: list[list[Node]]) -> list[PhysicalRow]:
        """
        Convert logical layers to physical rows.
        Splits wide layers across multiple rows to fit page width.

        Strategy: Keep spacing fixed, wrap nodes to new rows as needed.
        """
        physical_rows = []

        for layer_idx, layer in enumerate(logical_layers):
            # Calculate if layer fits in one row
            row_width = self._calculate_layer_width(layer)

            if row_width <= self.config.USABLE_WIDTH:
                # Fits in one row
                physical_rows.append(
                    PhysicalRow(
                        nodes=layer, logical_layer=layer_idx, row_type=RowType.FULL_LAYER
                    )
                )
            else:
                # Split into multiple rows
                split_rows = self._split_layer_balanced(layer, layer_idx)
                physical_rows.extend(split_rows)

        return physical_rows

    def _position_row_horizontal(self, row: PhysicalRow) -> None:
        """Position nodes within a row, centered."""
        # Calculate total width
        total_width = sum(self.nodes_by_id[n.id].size.x for n in row.nodes)
        total_width += (len(row.nodes) - 1) * self.config.BLOCK_GAP_X

        # Center the row
        start_x = (self.config.USABLE_WIDTH - total_width) / 2

        current_x = start_x
        for node in row.nodes:
            node_data = self.nodes_by_id[node.id]

            # Center vertically within row
            node_data.pos = Vec2(
                current_x, row.y_position + (row.height - node_data.size.y) / 2
            )

            current_x += node_data.size.x + self.config.BLOCK_GAP_X

    def _position_nodes(self, physical_rows: list[PhysicalRow]) -> None:
        """Assign X,Y coordinates to all nodes."""
        current_y = 0.0

        for row_idx, row in enumerate(physical_rows):
            row.y_position = current_y

            # Calculate row height (tallest node)
            row.height = max(self.nodes_by_id[n.id].size.y for n in row.nodes)

            # Position nodes horizontally within row
            self._position_row_horizontal(row)

            # Update node metadata
            for node in row.nodes:
                node_data = self.nodes_by_id[node.id]
                node_data.logical_layer = row.logical_layer
                node_data.physical_row = row_idx

            # Calculate gap to next row
            if row_idx < len(physical_rows) - 1:
                next_row = physical_rows[row_idx + 1]

                # Smaller gap if same layer (reflowed)
                if (
                    row.row_type == RowType.SPLIT_LAYER
                    and next_row.row_type == RowType.SPLIT_LAYER
                    and row.logical_layer == next_row.logical_layer
                ):
                    gap = self.config.ROW_GAP_Y
                else:
                    gap = self.config.BLOCK_GAP_Y

                current_y += row.height + gap
            else:
                current_y += row.height

    def _arrange_horizontal(self, nodes: list[NodeData]) -> None:
        """Arrange nodes in horizontal row."""
        x = 0.0
        for node in nodes:
            node.pos = Vec2(x, 0)
            x += node.size.x + self.config.BLOCK_GAP_X

    def _arrange_vertical(self, nodes: list[NodeData]) -> None:
        """Arrange nodes in vertical column."""
        y = 0.0
        for node in nodes:
            node.pos = Vec2(0, y)
            y += node.size.y + self.config.BLOCK_GAP_Y

    def _arrange_grid(self, nodes: list[NodeData]) -> None:
        """Arrange nodes in grid."""
        n = len(nodes)
        cols = math.ceil(math.sqrt(n))
        rows = math.ceil(n / cols)

        for i, node in enumerate(nodes):
            row = i // cols
            col = i % cols
            node.pos = Vec2(
                col * (self.config.MAX_BLOCK_WIDTH + self.config.BLOCK_GAP_X),
                row * (100 + self.config.BLOCK_GAP_Y),
            )

    def _layout_single_group(self, group: Group) -> None:
        """Layout nodes within a group and calculate bounding box."""
        group_nodes = [self.nodes_by_id[nid] for nid in group.nodes]

        # Arrange based on hint
        if group.arrangement == "horizontal":
            self._arrange_horizontal(group_nodes)
        elif group.arrangement == "vertical":
            self._arrange_vertical(group_nodes)
        elif group.arrangement == "grid":
            self._arrange_grid(group_nodes)
        else:  # auto
            if len(group_nodes) <= 3:
                self._arrange_horizontal(group_nodes)
            else:
                self._arrange_grid(group_nodes)

        # Calculate bounding box
        min_x = min(n.pos.x for n in group_nodes)
        min_y = min(n.pos.y for n in group_nodes)
        max_x = max(n.pos.x + n.size.x for n in group_nodes)
        max_y = max(n.pos.y + n.size.y for n in group_nodes)

        # Create group layout with padding
        self.groups_by_id[group.id] = GroupLayout(
            id=group.id,
            label=group.label,
            pos=Vec2(
                min_x - group.padding, min_y - group.padding - self.config.GROUP_LABEL_HEIGHT
            ),
            size=Vec2(
                (max_x - min_x) + 2 * group.padding,
                (max_y - min_y) + 2 * group.padding + self.config.GROUP_LABEL_HEIGHT,
            ),
            nodes=group.nodes,
            style=group.style,
            padding=group.padding,
        )

    def _layout_groups(self) -> None:
        """Calculate layout for all groups."""
        for group in self.diagram.groups:
            self._layout_single_group(group)

    def layout(self) -> LayoutResult:
        """
        Execute complete layout pipeline.

        Steps:
        1. Calculate node sizes
        2. Assign logical layers
        3. Reflow wide layers into multiple rows
        4. Position all nodes
        5. Layout groups
        6. Calculate final bounds
        """
        # Step 1: Calculate sizes for all nodes
        for node in self.diagram.nodes:
            size = calculate_block_size(node, self.config)
            self.nodes_by_id[node.id] = NodeData(
                id=node.id,
                label=node.label,
                type=node.type,
                size=size,
                pos=Vec2(0, 0),  # Will be set later
                logical_layer=-1,
                physical_row=-1,
            )

        # Step 2: Assign logical layers
        logical_layers = self._assign_logical_layers()

        # Step 3: Reflow layers to fit page width
        physical_rows = self._reflow_layers(logical_layers)

        # Step 4: Position nodes
        self._position_nodes(physical_rows)

        # Step 5: Layout groups (if any)
        if self.diagram.groups:
            self._layout_groups()

        # Step 6: Calculate final bounds
        all_nodes = list(self.nodes_by_id.values())
        width = max(n.pos.x + n.size.x for n in all_nodes)
        height = max(n.pos.y + n.size.y for n in all_nodes)

        # Adjust for groups if they're larger
        if self.groups_by_id:
            group_width = max(g.pos.x + g.size.x for g in self.groups_by_id.values())
            group_height = max(g.pos.y + g.size.y for g in self.groups_by_id.values())
            width = max(width, group_width)
            height = max(height, group_height)

        # Check if fits
        if width > self.config.USABLE_WIDTH:
            print(
                f"⚠ Warning: Diagram width {width:.0f}pt exceeds page width "
                f"{self.config.USABLE_WIDTH:.0f}pt"
            )

        if height > self.config.USABLE_HEIGHT:
            print(
                f"⚠ Warning: Diagram height {height:.0f}pt exceeds page height "
                f"{self.config.USABLE_HEIGHT:.0f}pt"
            )
            print("   Consider splitting into multiple diagrams")

        return LayoutResult(
            nodes=all_nodes,
            edges=self.diagram.edges,
            groups=list(self.groups_by_id.values()),
            physical_rows=physical_rows,
            width=width,
            height=height,
        )
