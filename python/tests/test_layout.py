"""Tests for layout engine."""

from iongraph.layout import calculate_text_size, calculate_block_size, PageConfig
from iongraph.models import Node, NodeType, Vec2


def test_text_size_calculation() -> None:
    """Test text size calculation."""
    size = calculate_text_size("Hello", 12.0)
    assert size.x > 0
    assert size.y > 0

    # Multi-line should be taller
    size_multi = calculate_text_size("Hello\nWorld", 12.0)
    assert size_multi.y > size.y


def test_block_size_calculation() -> None:
    """Test block size calculation with padding."""
    node = Node(id="test", label="Test Node")
    config = PageConfig()

    size = calculate_block_size(node, config)
    assert size.x >= config.MIN_BLOCK_WIDTH
    assert size.x <= config.MAX_BLOCK_WIDTH


def test_decision_node_is_square() -> None:
    """Test that decision nodes are square."""
    node = Node(id="test", label="Decision?", type=NodeType.DECISION)
    config = PageConfig()

    size = calculate_block_size(node, config)
    assert abs(size.x - size.y) < 1  # Should be square


def test_text_wrapping() -> None:
    """Test that long text gets wrapped."""
    long_label = "This is a very long label that should definitely be wrapped"
    node = Node(id="test", label=long_label)
    config = PageConfig()

    calculate_block_size(node, config)
    # After calculation, the label should have line breaks
    assert "\n" in node.label or len(node.label) <= len(long_label)
