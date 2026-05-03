import pytest
from src.tools.tool_registry import ToolRegistry

def test_tool_registry_registration():
    registry = ToolRegistry()
    
    def dummy_tool():
        """Dummy description."""
        pass
        
    registry.register("dummy", dummy_tool, "Dummy description.")
    
    tools = registry.get_all_tools()
    assert "dummy" in tools
    assert tools["dummy"]["description"] == "Dummy description."

def test_tool_registry_unregistration():
    registry = ToolRegistry()
    
    def dummy_tool():
        pass
        
    registry.register("dummy", dummy_tool, "desc")
    registry.unregister("dummy")
    
    tools = registry.get_all_tools()
    assert "dummy" not in tools

def test_tool_registry_get_tool():
    registry = ToolRegistry()
    
    def dummy_tool(x):
        return x * 2
        
    registry.register("dummy", dummy_tool, "desc")
    
    tool = registry.get_tool("dummy")
    assert tool is not None
    assert tool(5) == 10
