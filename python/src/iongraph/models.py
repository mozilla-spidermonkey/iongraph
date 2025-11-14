"""Data models for patent diagram generation."""

from dataclasses import dataclass
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class NodeType(str, Enum):
    """Shape types for diagram nodes."""

    BLOCK = "block"  # Rectangle (system components)
    DECISION = "decision"  # Diamond (yes/no decision)
    TERMINAL = "terminal"  # Rounded rectangle (start/end)
    PROCESS = "process"  # Rectangle (method steps)
    DATA = "data"  # Parallelogram (optional)


class Node(BaseModel):
    """A single node in the diagram."""

    id: str  # Unique identifier
    label: str  # Display text (supports \n for multiline)
    type: NodeType = NodeType.BLOCK  # Shape type

    # Optional overrides (normally auto-calculated)
    width: Optional[float] = None
    height: Optional[float] = None


class Edge(BaseModel):
    """Connection between two nodes."""

    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")  # Source node ID
    to: str  # Destination node ID
    label: Optional[str] = None  # Edge label (e.g., "yes", "no", "data")


class GroupStyle(str, Enum):
    """Border styles for groups."""

    SOLID = "solid"
    DASHED = "dashed"
    DOTTED = "dotted"
    DOUBLE = "double"


class Group(BaseModel):
    """Container for grouped nodes (subsystems)."""

    id: str
    label: str  # Group label with reference number
    nodes: list[str]  # IDs of contained nodes
    style: GroupStyle = GroupStyle.DASHED
    padding: float = 20  # Space between border and contents
    arrangement: Literal["auto", "horizontal", "vertical", "grid"] = "auto"


class DiagramType(str, Enum):
    """Type of diagram."""

    SYSTEM = "system"  # Apparatus/system diagram
    METHOD = "method"  # Method flowchart
    FLOWCHART = "flowchart"  # Alias for method


class Diagram(BaseModel):
    """Complete diagram specification."""

    title: str = ""
    type: DiagramType = DiagramType.SYSTEM

    nodes: list[Node]
    edges: list[Edge]
    groups: list[Group] = []  # Optional nested boxes

    # Lookup tables (populated after initialization)
    nodes_by_id: dict[str, Node] = {}
    groups_by_id: dict[str, Group] = {}

    def model_post_init(self, __context: object) -> None:
        """Build lookup tables after initialization."""
        self.nodes_by_id = {n.id: n for n in self.nodes}
        self.groups_by_id = {g.id: g for g in self.groups}

        # Validate edge references
        all_ids = set(self.nodes_by_id.keys()) | set(self.groups_by_id.keys())
        for edge in self.edges:
            if edge.from_ not in all_ids:
                raise ValueError(f"Edge source '{edge.from_}' not found")
            if edge.to not in all_ids:
                raise ValueError(f"Edge destination '{edge.to}' not found")


# Layout data structures


@dataclass
class Vec2:
    """2D vector for positions and sizes."""

    x: float
    y: float

    def __add__(self, other: "Vec2") -> "Vec2":
        return Vec2(self.x + other.x, self.y + other.y)

    def __sub__(self, other: "Vec2") -> "Vec2":
        return Vec2(self.x - other.x, self.y - other.y)

    def __mul__(self, scalar: float) -> "Vec2":
        return Vec2(self.x * scalar, self.y * scalar)


class RowType(Enum):
    """Type of physical row."""

    FULL_LAYER = "full"  # Complete layer in one row
    SPLIT_LAYER = "split"  # Part of a reflowed layer


@dataclass
class NodeData:
    """Node with calculated layout information."""

    id: str
    label: str
    type: NodeType
    size: Vec2  # Calculated width/height
    pos: Vec2  # Absolute position
    logical_layer: int  # Original layer number
    physical_row: int  # Actual row on page


@dataclass
class PhysicalRow:
    """A physical row of nodes on the page."""

    nodes: list[Node]
    logical_layer: int  # Which layer this represents
    row_type: RowType
    y_position: float = 0  # Y coordinate (set during layout)
    height: float = 0  # Max node height in row


@dataclass
class GroupLayout:
    """Calculated layout for a group."""

    id: str
    label: str
    pos: Vec2  # Top-left corner
    size: Vec2  # Total width/height
    nodes: list[str]  # Node IDs
    style: GroupStyle
    padding: float


@dataclass
class LayoutResult:
    """Complete layout result."""

    nodes: list[NodeData]
    edges: list[Edge]
    groups: list[GroupLayout]
    physical_rows: list[PhysicalRow]
    width: float  # Total diagram width
    height: float  # Total diagram height
