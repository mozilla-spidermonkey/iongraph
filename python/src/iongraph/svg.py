"""SVG generation for patent diagrams."""

from .layout import PageConfig
from .models import Edge, GroupLayout, GroupStyle, LayoutResult, NodeData, NodeType, Vec2


def escape_xml(text: str) -> str:
    """Escape XML special characters."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def simple_arrow(src_pos: Vec2, dst_pos: Vec2, radius: float = 8.0) -> str:
    """
    Generate simple orthogonal arrow path with quarter-circle arcs.

    Path structure:
    1. Start at source (output port at bottom)
    2. Go down vertically
    3. Turn horizontally (quarter-circle arc)
    4. Route to destination X
    5. Turn down (quarter-circle arc)
    6. Arrive at destination (input port at top)
    """
    path = []

    # Start point (bottom center of source)
    path.append(f"M {src_pos.x},{src_pos.y}")

    # Determine routing
    dx = dst_pos.x - src_pos.x
    dy = dst_pos.y - src_pos.y

    if abs(dx) < 1:  # Straight down
        path.append(f"L {dst_pos.x},{dst_pos.y}")
    else:
        # Go down
        turn_y = src_pos.y + 20
        path.append(f"L {src_pos.x},{turn_y}")

        # Arc to horizontal
        if dx > 0:  # Turn right
            arc_end = Vec2(src_pos.x + radius, turn_y + radius)
            path.append(f"A {radius},{radius} 0 0 1 {arc_end.x},{arc_end.y}")

            # Horizontal segment
            path.append(f"L {dst_pos.x - radius},{turn_y + radius}")

            # Arc down
            arc_end2 = Vec2(dst_pos.x, turn_y + 2 * radius)
            path.append(f"A {radius},{radius} 0 0 1 {arc_end2.x},{arc_end2.y}")
        else:  # Turn left
            arc_end = Vec2(src_pos.x - radius, turn_y + radius)
            path.append(f"A {radius},{radius} 0 0 0 {arc_end.x},{arc_end.y}")

            # Horizontal segment
            path.append(f"L {dst_pos.x + radius},{turn_y + radius}")

            # Arc down
            arc_end2 = Vec2(dst_pos.x, turn_y + 2 * radius)
            path.append(f"A {radius},{radius} 0 0 0 {arc_end2.x},{arc_end2.y}")

        # Final vertical to destination
        path.append(f"L {dst_pos.x},{dst_pos.y - 5}")

    return " ".join(path)


def render_edge(
    edge: Edge,
    nodes_by_id: dict[str, NodeData],
    groups_by_id: dict[str, GroupLayout],
    radius: float,
) -> str:
    """Render a single edge."""
    # Determine source position
    if edge.from_ in groups_by_id:
        group = groups_by_id[edge.from_]
        src_pos = Vec2(group.pos.x + group.size.x / 2, group.pos.y + group.size.y)
    else:
        node = nodes_by_id[edge.from_]
        src_pos = Vec2(node.pos.x + node.size.x / 2, node.pos.y + node.size.y)

    # Determine destination position
    if edge.to in groups_by_id:
        group = groups_by_id[edge.to]
        dst_pos = Vec2(group.pos.x + group.size.x / 2, group.pos.y)
    else:
        node = nodes_by_id[edge.to]
        dst_pos = Vec2(node.pos.x + node.size.x / 2, node.pos.y)

    # Generate path
    path = simple_arrow(src_pos, dst_pos, radius)

    # Arrowhead (simple triangle)
    arrow_size = 5
    arrow_path = (
        f"M {dst_pos.x - arrow_size},{dst_pos.y - 2*arrow_size} "
        f"L {dst_pos.x},{dst_pos.y} "
        f"L {dst_pos.x + arrow_size},{dst_pos.y - 2*arrow_size} Z"
    )

    result = f'<path class="edge" d="{path}" />\n'
    result += f'    <path class="arrowhead" d="{arrow_path}" />'

    # Add edge label if present
    if edge.label:
        # Position label near the middle of the edge
        mid_x = (src_pos.x + dst_pos.x) / 2
        mid_y = (src_pos.y + dst_pos.y) / 2
        result += (
            f'\n    <text class="edge-label" x="{mid_x}" y="{mid_y - 5}" '
            f'text-anchor="middle">{escape_xml(edge.label)}</text>'
        )

    return result


def render_node(node: NodeData, font_size: float) -> str:
    """Render a single node based on its type."""
    x, y = node.pos.x, node.pos.y
    w, h = node.size.x, node.size.y

    lines = [f'<g id="{node.id}">']

    if node.type == NodeType.DECISION:
        # Diamond shape
        cx, cy = x + w / 2, y + h / 2
        points = [
            f"{cx},{y}",  # Top
            f"{x+w},{cy}",  # Right
            f"{cx},{y+h}",  # Bottom
            f"{x},{cy}",  # Left
        ]
        lines.append(f'  <polygon class="decision" points="{" ".join(points)}" />')
        text_x, text_y = cx, cy

    elif node.type == NodeType.TERMINAL:
        # Rounded rectangle
        lines.append(
            f'  <rect class="terminal" x="{x}" y="{y}" width="{w}" height="{h}" rx="20" />'
        )
        text_x, text_y = x + w / 2, y + h / 2

    else:
        # Regular rectangle (block/process)
        lines.append(f'  <rect class="block" x="{x}" y="{y}" width="{w}" height="{h}" />')
        text_x, text_y = x + w / 2, y + h / 2

    # Render text (handle multi-line)
    label_lines = node.label.split("\n")
    line_height = font_size * 1.25
    start_y = text_y - (len(label_lines) - 1) * line_height / 2 + 5

    for i, text_line in enumerate(label_lines):
        y_pos = start_y + i * line_height
        lines.append(
            f'  <text x="{text_x}" y="{y_pos}" text-anchor="middle">'
            f"{escape_xml(text_line)}</text>"
        )

    lines.append("</g>")
    return "\n".join(lines)


def render_group(group: GroupLayout) -> str:
    """Render a group box."""
    x, y = group.pos.x, group.pos.y
    w, h = group.size.x, group.size.y

    # Choose stroke style
    if group.style == GroupStyle.DASHED:
        style = 'stroke-dasharray="10,5"'
    elif group.style == GroupStyle.DOTTED:
        style = 'stroke-dasharray="2,3"'
    elif group.style == GroupStyle.DOUBLE:
        # Draw two rectangles
        return (
            f'<g id="group-{group.id}">\n'
            f'  <rect class="group-box" x="{x}" y="{y}" width="{w}" height="{h}" rx="5" />\n'
            f'  <rect class="group-box" x="{x+3}" y="{y+3}" '
            f'width="{w-6}" height="{h-6}" rx="5" />\n'
            f'  <text class="group-label" x="{x + 10}" y="{y + 20}">'
            f"{escape_xml(group.label)}</text>\n"
            f"</g>"
        )
    else:  # SOLID
        style = ""

    return (
        f'<g id="group-{group.id}">\n'
        f'  <rect class="group-box" x="{x}" y="{y}" width="{w}" height="{h}" rx="5" {style}/>\n'
        f'  <text class="group-label" x="{x + 10}" y="{y + 20}">'
        f"{escape_xml(group.label)}</text>\n"
        f"</g>"
    )


def render_svg(layout: LayoutResult, config: PageConfig, page_size: bool = True) -> str:
    """
    Generate complete SVG document.

    Args:
        layout: Layout result with positioned nodes
        config: Page configuration
        page_size: If True, output is letter-size with margins
    """
    if page_size:
        svg_width = config.LETTER_WIDTH_PT
        svg_height = config.LETTER_HEIGHT_PT
        margin = config.MARGIN_PT
    else:
        # Tight bounding box
        svg_width = layout.width + 20
        svg_height = layout.height + 20
        margin = 10

    svg = [
        f'<svg width="{svg_width}pt" height="{svg_height}pt" ',
        f'     viewBox="0 0 {svg_width} {svg_height}" ',
        '     xmlns="http://www.w3.org/2000/svg">',
        "",
        "<style>",
        f'  text {{ font-family: "Courier New", monospace; font-size: {config.FONT_SIZE}pt; }}',
        "  .block { fill: white; stroke: black; stroke-width: 1.5; }",
        "  .decision { fill: white; stroke: black; stroke-width: 1.5; }",
        "  .terminal { fill: white; stroke: black; stroke-width: 1.5; }",
        "  .process { fill: white; stroke: black; stroke-width: 1.5; }",
        "  .edge { fill: none; stroke: black; stroke-width: 1.5; }",
        "  .arrowhead { fill: black; stroke: black; stroke-width: 1.5; }",
        "  .edge-label { font-size: 10pt; fill: black; }",
        "  .group-box { fill: none; stroke: black; stroke-width: 2; }",
        "  .group-label { font-size: 14pt; font-weight: bold; }",
        "  .page-margin { fill: none; stroke: lightgray; "
        "stroke-width: 0.5; stroke-dasharray: 5,5; }",
        "</style>",
        "",
    ]

    # Optional page margin guide
    if page_size:
        svg.append(
            f'<rect class="page-margin" x="{margin}" y="{margin}" '
            f'width="{svg_width - 2*margin}" height="{svg_height - 2*margin}" />'
        )

    # Group content with margin offset
    svg.append(f'<g transform="translate({margin},{margin})">')

    # Layer 1: Groups (background)
    if layout.groups:
        svg.append('  <g class="groups">')
        for group in layout.groups:
            svg.append("    " + render_group(group))
        svg.append("  </g>")

    # Layer 2: Edges (middle)
    svg.append('  <g class="edges">')
    nodes_dict = {n.id: n for n in layout.nodes}
    groups_dict = {g.id: g for g in layout.groups}

    for edge in layout.edges:
        edge_svg = render_edge(edge, nodes_dict, groups_dict, config.EDGE_RADIUS)
        svg.append("    " + edge_svg)
    svg.append("  </g>")

    # Layer 3: Nodes (foreground)
    svg.append('  <g class="nodes">')
    for node in layout.nodes:
        svg.append("    " + render_node(node, config.FONT_SIZE))
    svg.append("  </g>")

    svg.append("</g>")
    svg.append("</svg>")

    return "\n".join(svg)
