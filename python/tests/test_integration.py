"""Integration tests for complete pipeline."""

from pathlib import Path
from iongraph.models import Diagram
from iongraph.layout import LayoutEngine, PageConfig
from iongraph.svg import render_svg


def test_full_pipeline() -> None:
    """Test complete pipeline from JSON to SVG."""
    json_str = """
    {
      "title": "Test System",
      "nodes": [
        {"id": "a", "label": "Input"},
        {"id": "b", "label": "Process"},
        {"id": "c", "label": "Output"}
      ],
      "edges": [
        {"from": "a", "to": "b"},
        {"from": "b", "to": "c"}
      ]
    }
    """

    # Parse
    diagram = Diagram.model_validate_json(json_str)

    # Layout
    config = PageConfig()
    engine = LayoutEngine(diagram, config)
    layout = engine.layout()

    # Render
    svg = render_svg(layout, config)

    # Validate
    assert "<svg" in svg
    assert "Input" in svg
    assert "Process" in svg
    assert "Output" in svg
    assert "<path" in svg  # Has edges


def test_wide_diagram_reflows() -> None:
    """Test that wide diagrams are reflowed."""
    # Create diagram with many nodes in one layer
    nodes = [{"id": f"n{i}", "label": f"Node {i}"} for i in range(10)]
    edges = [{"from": "n0", "to": f"n{i}"} for i in range(1, 10)]

    diagram = Diagram(nodes=nodes, edges=edges)

    config = PageConfig()
    engine = LayoutEngine(diagram, config)
    layout = engine.layout()

    # Should have multiple physical rows
    assert len(layout.physical_rows) > 1

    # Final width should fit
    assert layout.width <= config.USABLE_WIDTH


def test_example_files_are_valid(tmp_path: Path) -> None:
    """Test that example JSON files can be processed."""
    examples_dir = Path(__file__).parent.parent / "examples"

    for example_file in examples_dir.glob("*.json"):
        # Parse
        diagram = Diagram.model_validate_json(example_file.read_text())

        # Layout
        config = PageConfig()
        engine = LayoutEngine(diagram, config)
        layout = engine.layout()

        # Render
        svg = render_svg(layout, config)

        # Should produce valid SVG
        assert "<svg" in svg
        assert "</svg>" in svg

        # Save to temp file to verify it can be written
        output_file = tmp_path / f"{example_file.stem}.svg"
        output_file.write_text(svg)
        assert output_file.exists()
