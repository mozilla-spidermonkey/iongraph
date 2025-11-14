"""CLI entry point for patent diagram generator."""

from pathlib import Path
from collections import Counter

import click

from .models import Diagram
from .layout import LayoutEngine, PageConfig
from .svg import render_svg


@click.group()
def cli() -> None:
    """Patent diagram generator - create publication-ready diagrams from JSON."""
    pass


@cli.command()
@click.argument("input_file", type=click.Path(exists=True))
@click.argument("output_file", type=click.Path())
@click.option("--no-page", is_flag=True, help="Use tight bounding box instead of letter page")
@click.option("--landscape", is_flag=True, help="Use landscape orientation")
@click.option("--font-size", type=float, default=12.0, help="Font size in points (default: 12)")
def render(
    input_file: str, output_file: str, no_page: bool, landscape: bool, font_size: float
) -> None:
    """Generate SVG diagram from JSON input."""
    # Load and parse input
    try:
        with open(input_file) as f:
            diagram = Diagram.model_validate_json(f.read())
    except Exception as e:
        click.echo(f"❌ Error parsing input: {e}", err=True)
        return

    # Configure
    config = PageConfig()
    config.FONT_SIZE = font_size

    if landscape:
        config.USABLE_WIDTH, config.USABLE_HEIGHT = config.USABLE_HEIGHT, config.USABLE_WIDTH

    # Layout
    click.echo(f"📐 Laying out {len(diagram.nodes)} nodes, {len(diagram.edges)} edges...")

    try:
        engine = LayoutEngine(diagram, config)
        layout = engine.layout()
    except Exception as e:
        click.echo(f"❌ Layout error: {e}", err=True)
        return

    # Render
    click.echo("🎨 Rendering SVG...")
    svg_content = render_svg(layout, config, page_size=not no_page)

    # Write
    Path(output_file).write_text(svg_content)

    # Summary
    click.echo(f"✓ {output_file}")
    click.echo(f"  Diagram size: {layout.width:.0f}×{layout.height:.0f} pt")
    click.echo(f"  Font size: {config.FONT_SIZE}pt")
    if layout.groups:
        click.echo(f"  Groups: {len(layout.groups)}")


@cli.command()
@click.argument("input_file", type=click.Path(exists=True))
def info(input_file: str) -> None:
    """Display information about a diagram file."""
    try:
        with open(input_file) as f:
            diagram = Diagram.model_validate_json(f.read())
    except Exception as e:
        click.echo(f"❌ Error: {e}", err=True)
        return

    click.echo(f"Title: {diagram.title or '(untitled)'}")
    click.echo(f"Type: {diagram.type.value}")
    click.echo(f"Nodes: {len(diagram.nodes)}")
    click.echo(f"Edges: {len(diagram.edges)}")

    if diagram.groups:
        click.echo(f"Groups: {len(diagram.groups)}")

    # Node types breakdown
    type_counts = Counter(n.type for n in diagram.nodes)
    click.echo("\nNode types:")
    for node_type, count in type_counts.items():
        click.echo(f"  {node_type.value}: {count}")


@cli.command()
def example() -> None:
    """Print an example diagram JSON."""
    example_json = """{
  "title": "Temperature Monitoring System",
  "type": "system",
  "nodes": [
    {"id": "sensor", "label": "Temperature Sensor\\n(102)", "type": "block"},
    {"id": "processor", "label": "Microprocessor\\n(104)", "type": "block"},
    {"id": "display", "label": "Display\\n(106)", "type": "terminal"}
  ],
  "edges": [
    {"from": "sensor", "to": "processor", "label": "analog signal"},
    {"from": "processor", "to": "display", "label": "display data"}
  ]
}"""

    click.echo(example_json)


if __name__ == "__main__":
    cli()
