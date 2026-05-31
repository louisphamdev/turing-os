"""Unit tests for the ToolRegistry class."""

from src.tools.tool_registry import ToolRegistry


def test_tool_registry_register_local():
    """register_local stores a function in local_tools without touching BookStack."""
    registry = ToolRegistry()

    def dummy_tool():
        """Dummy description."""
        pass

    result = registry.register_local("dummy", dummy_tool, share=False)

    assert result["success"] is True
    assert "dummy" in registry.local_tools
    assert registry.local_tools["dummy"] is dummy_tool


def test_tool_registry_unregister_removes_local():
    """unregister_tool removes from local_tools (and wiki_tools if present)."""
    registry = ToolRegistry()

    def dummy_tool():
        pass

    registry.register_local("dummy", dummy_tool, share=False)
    assert "dummy" in registry.local_tools

    result = registry.unregister_tool("dummy", delete_from_wiki=False)
    assert result["success"] is True
    assert "dummy" not in registry.local_tools


def test_tool_registry_register_local_is_callable():
    """A registered function remains directly callable from local_tools."""
    registry = ToolRegistry()

    def double(x):
        return x * 2

    registry.register_local("double", double, share=False)
    assert registry.local_tools["double"](5) == 10
