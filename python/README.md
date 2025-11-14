# Patent Diagram Generator (Python)

Generate publication-ready block diagrams and flowcharts for patent applications from simple JSON.

## Features

- 📐 **Automatic layout** with layer reflowing to fit US Letter pages
- 📝 **12pt fixed font** (patent standard)
- 📄 **US Letter output** (8.5" × 11") with proper margins
- 📦 **Nested boxes** for subsystems and grouping
- 🎨 **Clean SVG output** suitable for patent submissions
- ⚡ **Minimal dependencies** (just pydantic and click)

## Installation

```bash
cd python
pip install -e .
```

For development:

```bash
pip install -e ".[dev]"
```

## Quick Start

Create a JSON file describing your diagram:

```json
{
  "title": "My System",
  "nodes": [
    {"id": "a", "label": "Component A\n(102)"},
    {"id": "b", "label": "Component B\n(104)"}
  ],
  "edges": [
    {"from": "a", "to": "b", "label": "connection"}
  ]
}
```

Generate SVG:

```bash
iongraph render diagram.json output.svg
```

## Usage

### Basic Command

```bash
iongraph render INPUT.json OUTPUT.svg
```

### Options

- `--landscape` - Use landscape orientation (10" × 7.5")
- `--no-page` - Tight bounding box instead of letter page
- `--font-size SIZE` - Custom font size (default: 12pt)

### Info Command

Display information about a diagram:

```bash
iongraph info diagram.json
```

### Example Command

Print example JSON:

```bash
iongraph example
```

## JSON Schema

### Node Types

- `block` - Rectangle (system components) - **default**
- `decision` - Diamond (yes/no decisions)
- `terminal` - Rounded rectangle (start/end)
- `process` - Rectangle (method steps)
- `data` - Parallelogram (data input/output)

### Diagram Types

- `system` - Apparatus/system diagram (default)
- `method` - Method flowchart
- `flowchart` - Alias for method

### Complete Example

See `examples/simple_system.json`:

```json
{
  "title": "Simple Data Processing System",
  "type": "system",
  "nodes": [
    {"id": "sensor", "label": "Temperature Sensor\n(102)", "type": "block"},
    {"id": "adc", "label": "ADC\n(104)", "type": "block"},
    {"id": "cpu", "label": "Microprocessor\n(106)", "type": "block"},
    {"id": "display", "label": "Display\n(108)", "type": "terminal"}
  ],
  "edges": [
    {"from": "sensor", "to": "adc", "label": "analog"},
    {"from": "adc", "to": "cpu", "label": "digital"},
    {"from": "cpu", "to": "display"}
  ]
}
```

### Groups (Subsystems)

Groups allow you to nest nodes within a labeled container:

```json
{
  "nodes": [
    {"id": "core1", "label": "Core 1\n(102)"},
    {"id": "core2", "label": "Core 2\n(104)"},
    {"id": "cache", "label": "Cache\n(106)"}
  ],
  "groups": [
    {
      "id": "cpu",
      "label": "CPU Package 100",
      "nodes": ["core1", "core2", "cache"],
      "style": "dashed",
      "arrangement": "grid"
    }
  ],
  "edges": [...]
}
```

Group styles:
- `solid` - Solid border
- `dashed` - Dashed border (default)
- `dotted` - Dotted border
- `double` - Double border

Group arrangements:
- `auto` - Automatic (horizontal for ≤3 nodes, grid otherwise)
- `horizontal` - Horizontal row
- `vertical` - Vertical column
- `grid` - Grid layout

## Examples

The `examples/` directory contains three sample diagrams:

1. **simple_system.json** - Basic system diagram with 4 components
2. **method_flowchart.json** - Method flowchart with decision nodes
3. **nested_groups.json** - System with grouped subsystem

Generate all examples:

```bash
cd python
iongraph render examples/simple_system.json simple_system.svg
iongraph render examples/method_flowchart.json method_flowchart.svg
iongraph render examples/nested_groups.json nested_groups.svg
```

## Development

### Run Tests

```bash
pytest
```

With coverage:

```bash
pytest --cov=iongraph --cov-report=html
```

### Type Checking

```bash
mypy src/iongraph
```

### Code Formatting

```bash
black src/ tests/
```

### Linting

```bash
ruff check src/ tests/
```

## Architecture

```
Input JSON → Pydantic Parser → Layout Engine → SVG Generator → Output File
```

### Layout Algorithm

1. **Size Calculation**: Calculate node dimensions based on text content
2. **Layer Assignment**: Topological sort to assign nodes to logical layers
3. **Reflowing**: Split wide layers across multiple rows to fit page width
4. **Positioning**: Assign X,Y coordinates to all nodes with centered rows
5. **Group Layout**: Calculate bounding boxes for grouped nodes
6. **SVG Generation**: Generate clean SVG with proper styling

### Key Design Decisions

- **Fixed 12pt font**: Never scales text (patent requirement)
- **Fixed spacing**: Consistent gaps between elements
- **Reflow vs. scale**: Wide diagrams wrap to new rows instead of shrinking
- **Simple routing**: Orthogonal edges with quarter-circle arcs
- **Minimal dependencies**: Only pydantic and click required

## Patent Diagram Best Practices

1. **Use reference numbers**: Label components with (100), (102), etc.
2. **Clear labels**: Short, descriptive labels (use \n for multi-line)
3. **Logical flow**: Arrange from top to bottom, left to right
4. **Group subsystems**: Use groups for related components
5. **Label edges**: Describe connections (e.g., "data", "control signal")
6. **One concept per diagram**: Don't overcrowd - split complex systems

## Limitations

- **No interactive editing**: This is a command-line tool, not a GUI
- **Basic routing**: Uses simple orthogonal paths, not optimal routing
- **Single page**: Very large diagrams may exceed page height
- **No automatic splitting**: Manual intervention needed for oversized diagrams

## License

MPL-2.0 (matching original iongraph license)

## Related Projects

This Python tool complements the main [iongraph](https://github.com/bvisness/iongraph) web-based visualization library. Use the web version for interactive exploration and the Python tool for generating patent-quality static diagrams.

## Contributing

Contributions welcome! Please ensure:

1. All tests pass (`pytest`)
2. Type checking passes (`mypy src/iongraph`)
3. Code is formatted (`black src/ tests/`)
4. Linting passes (`ruff check src/ tests/`)

## Support

For issues or questions, please file an issue on GitHub.
