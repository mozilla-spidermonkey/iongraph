"""Tests for data models."""

import pytest
from iongraph.models import Diagram, Node, Edge, NodeType


def test_simple_diagram_parsing() -> None:
    """Test parsing a simple diagram."""
    json_str = """
    {
      "nodes": [
        {"id": "a", "label": "Node A"},
        {"id": "b", "label": "Node B"}
      ],
      "edges": [
        {"from": "a", "to": "b"}
      ]
    }
    """

    diagram = Diagram.model_validate_json(json_str)
    assert len(diagram.nodes) == 2
    assert len(diagram.edges) == 1
    assert diagram.nodes[0].type == NodeType.BLOCK


def test_invalid_edge_reference() -> None:
    """Test that invalid edge references are caught."""
    json_str = """
    {
      "nodes": [{"id": "a", "label": "Node A"}],
      "edges": [{"from": "a", "to": "nonexistent"}]
    }
    """

    with pytest.raises(ValueError, match="not found"):
        Diagram.model_validate_json(json_str)


def test_node_types() -> None:
    """Test different node types."""
    json_str = """
    {
      "nodes": [
        {"id": "a", "label": "Block", "type": "block"},
        {"id": "b", "label": "Decision", "type": "decision"},
        {"id": "c", "label": "Terminal", "type": "terminal"}
      ],
      "edges": []
    }
    """

    diagram = Diagram.model_validate_json(json_str)
    assert diagram.nodes[0].type == NodeType.BLOCK
    assert diagram.nodes[1].type == NodeType.DECISION
    assert diagram.nodes[2].type == NodeType.TERMINAL


def test_diagram_with_groups() -> None:
    """Test diagram with groups."""
    json_str = """
    {
      "nodes": [
        {"id": "a", "label": "Node A"},
        {"id": "b", "label": "Node B"}
      ],
      "edges": [],
      "groups": [
        {
          "id": "g1",
          "label": "Group 1",
          "nodes": ["a", "b"],
          "style": "dashed"
        }
      ]
    }
    """

    diagram = Diagram.model_validate_json(json_str)
    assert len(diagram.groups) == 1
    assert diagram.groups[0].id == "g1"
    assert len(diagram.groups[0].nodes) == 2
