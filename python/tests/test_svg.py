"""Tests for SVG generation."""

from iongraph.svg import escape_xml, render_node
from iongraph.models import NodeData, NodeType, Vec2


def test_xml_escaping() -> None:
    """Test XML special character escaping."""
    assert escape_xml("A & B") == "A &amp; B"
    assert escape_xml("<tag>") == "&lt;tag&gt;"
    assert escape_xml("it's") == "it&apos;s"


def test_node_rendering() -> None:
    """Test basic node rendering."""
    node = NodeData(
        id="test",
        label="Test",
        type=NodeType.BLOCK,
        size=Vec2(100, 50),
        pos=Vec2(10, 20),
        logical_layer=0,
        physical_row=0,
    )

    svg = render_node(node, 12.0)
    assert "<rect" in svg
    assert 'id="test"' in svg
    assert "Test" in svg


def test_decision_node_rendering() -> None:
    """Test decision node (diamond) rendering."""
    node = NodeData(
        id="decision",
        label="Is Valid?",
        type=NodeType.DECISION,
        size=Vec2(100, 100),
        pos=Vec2(10, 20),
        logical_layer=0,
        physical_row=0,
    )

    svg = render_node(node, 12.0)
    assert "<polygon" in svg
    assert 'class="decision"' in svg
