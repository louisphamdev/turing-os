"""
Tool Registry — Persistent Tool Storage via Wiki.js

Provides persistent, shared tool storage across workers:
- Tools are stored in Wiki.js as JSON pages
- Workers load tools from Wiki on startup
- New tools can be saved to Wiki for sharing
- Tool definitions include: name, description, module, function, parameters

Storage format (Wiki page):
  Path: /tools/{tool_name}
  Content: JSON with tool definition
  Tags: ["turing-tool", "shared"]
"""

import os
import json
import importlib
from typing import Optional, Callable, Any

WIKI_URL = os.environ.get('WIKI_URL', 'http://wiki:3000')
WIKI_JWT_TOKEN = os.environ.get('WIKI_JWT_TOKEN', '')

# ─── Wiki Tool Storage ──────────────────────────────────────────────────────

TOOLS_PAGE_PATH_PREFIX = '/tools/'


def _wiki_query(query: str, variables: dict = None) -> dict:
    """Make GraphQL request to Wiki.js"""
    import requests

    url = f"{WIKI_URL}/graphql"
    headers = {
        'Authorization': f'Bearer {WIKI_JWT_TOKEN}',
        'Content-Type': 'application/json',
    }

    try:
        resp = requests.post(url, headers=headers, json={'query': query, 'variables': variables}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if 'errors' in data:
            return {'error': '; '.join([e.get('message', str(e)) for e in data['errors']])}
        return data.get('data', {})
    except Exception as e:
        return {'error': str(e)}


def _find_page_by_path(path: str) -> Optional[dict]:
    """Find a Wiki page by its path"""
    query = """
    query($path: String!) {
      pages {
        singleByPath(path: $path) {
          id
          title
          content
        }
      }
    }
    """
    result = _wiki_query(query, {'path': path})
    if 'error' in result:
        return None
    page = result.get('pages', {}).get('singleByPath')
    return page if page else None


def _create_or_update_page(path: str, title: str, content: str, tags: list = None) -> dict:
    """Create or update a Wiki page"""
    existing = _find_page_by_path(path)
    
    if existing:
        # Update existing page
        page_id = existing['id']
        mutation = """
        mutation($id: Int!, $content: String!) {
          pages {
            update(id: $id, content: $content) {
              id
              title
            }
          }
        }
        """
        result = _wiki_query(mutation, {'id': int(page_id), 'content': content})
    else:
        # Create new page - need parent folder first
        parent_path = '/tools'
        parent = _find_page_by_path(parent_path)
        if not parent:
            # Create /tools folder
            _create_folder('/tools', 'Shared Tools')
            parent = _find_page_by_path(parent_path)
        
        mutation = """
        mutation($content: String!, $description: String, $path: String!, $title: String!) {
          pages {
            create(content: $content, description: $description, path: $path, title: $title) {
              id
              path
            }
          }
        }
        """
        result = _wiki_query(mutation, {
            'content': content,
            'description': f'Turing OS shared tool: {title}',
            'path': path,
            'title': title,
        })
    
    return result


def _create_folder(path: str, title: str) -> bool:
    """Create a Wiki folder"""
    mutation = """
    mutation($path: String!, $title: String!) {
      storage {
        createFolder(path: $path, name: $title) {
          success
        }
      }
    }
    """
    result = _wiki_query(mutation, {'path': path, 'title': title})
    return result.get('storage', {}).get('createFolder', {}).get('success', False)


# ─── Tool Definition Schema ─────────────────────────────────────────────────

TOOL_DEFINITION_SCHEMA = {
    "name": "string (required) - Tool name",
    "description": "string - Human-readable description",
    "module": "string - Python module path (e.g., 'mymodule')",
    "function": "string - Function name in the module",
    "parameters": {
        "type": "object",
        "properties": {
            "param_name": {"type": "string", "description": "description"}
        }
    },
    "tags": ["optional tags for categorization"],
    "created_by": "worker ticket_id",
    "created_at": "ISO timestamp"
}


def save_tool_to_wiki(
    tool_name: str,
    module_path: str,
    function_name: str,
    description: str = "",
    parameters: dict = None,
    tags: list = None,
    created_by: str = None,
) -> dict:
    """
    Save a tool definition to Wiki.js for sharing across workers.
    
    Returns: { success: bool, message: str, page_id: str or None }
    """
    import time
    
    tool_def = {
        "name": tool_name,
        "description": description,
        "module": module_path,
        "function": function_name,
        "parameters": parameters or {},
        "tags": tags or [],
        "created_by": created_by or os.environ.get('TICKET_ID', 'unknown'),
        "created_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        "version": "1.0",
    }
    
    content = json.dumps(tool_def, indent=2)
    page_path = f"{TOOLS_PAGE_PATH_PREFIX}{tool_name}"
    page_title = f"Tool: {tool_name}"
    
    result = _create_or_update_page(page_path, page_title, content, tags)
    
    if 'error' in result:
        return {'success': False, 'message': f"Wiki error: {result['error']}"}
    
    return {
        'success': True,
        'message': f"Tool '{tool_name}' saved to Wiki at {page_path}",
        'page_path': page_path,
    }


def load_tool_from_wiki(tool_name: str) -> Optional[dict]:
    """
    Load a tool definition from Wiki.js.
    
    Returns the tool definition dict or None if not found.
    """
    page_path = f"{TOOLS_PAGE_PATH_PREFIX}{tool_name}"
    page = _find_page_by_path(page_path)
    
    if not page:
        return None
    
    try:
        content = page.get('content', '')
        if content.startswith('```'):
            # Strip markdown code blocks
            lines = content.split('\n')
            if lines[0].startswith('```'):
                lines = lines[1:]
            if lines and lines[-1].startswith('```'):
                lines = lines[:-1]
            content = '\n'.join(lines)
        
        return json.loads(content)
    except json.JSONDecodeError:
        return None


def list_tools_from_wiki() -> list:
    """
    List all shared tools available in Wiki.
    
    Returns list of tool definition dicts.
    """
    # First ensure /tools folder exists
    if not _find_page_by_path('/tools'):
        _create_folder('/tools', 'Shared Tools')
    
    # Query pages under /tools path
    query = """
    query {
      pages {
        list(path: "/tools", limit: 100) {
          results {
            id
            title
            path
            content
            tags {
              title
            }
          }
        }
      }
    }
    """
    
    result = _wiki_query(query)
    if 'error' in result:
        return []
    
    pages = result.get('pages', {}).get('list', {}).get('results', [])
    tools = []
    
    for page in pages:
        if page.get('path', '').startswith('/tools/') and page.get('path') != '/tools':
            try:
                content = page.get('content', '')
                if content:
                    tool_def = json.loads(content)
                    tool_def['_wiki_page_id'] = page.get('id')
                    tool_def['_wiki_path'] = page.get('path')
                    tools.append(tool_def)
            except json.JSONDecodeError:
                continue
    
    return tools


def delete_tool_from_wiki(tool_name: str) -> dict:
    """
    Delete a tool from Wiki.
    
    Returns: { success: bool, message: str }
    """
    page_path = f"{TOOLS_PAGE_PATH_PREFIX}{tool_name}"
    page = _find_page_by_path(page_path)
    
    if not page:
        return {'success': False, 'message': f"Tool '{tool_name}' not found in Wiki"}
    
    page_id = page.get('id')
    if not page_id:
        return {'success': False, 'message': f"Could not get page ID for '{tool_name}'"}
    
    mutation = """
    mutation($id: Int!) {
      pages {
        delete(id: $id) {
          id
        }
      }
    }
    """
    
    result = _wiki_query(mutation, {'id': int(page_id)})
    if 'error' in result:
        return {'success': False, 'message': f"Delete failed: {result['error']}"}
    
    return {'success': True, 'message': f"Tool '{tool_name}' deleted from Wiki"}


# ─── Dynamic Tool Loader ────────────────────────────────────────────────────

# Cache of loaded tools
_loaded_tool_funcs: dict = {}


def load_tool_func(tool_def: dict) -> Optional[Callable]:
    """
    Load and return a tool function from its Wiki definition.
    
    The function is loaded from the specified module and function name.
    """
    tool_name = tool_def.get('name')
    module_path = tool_def.get('module')
    function_name = tool_def.get('function')
    
    if not module_path or not function_name:
        return None
    
    cache_key = f"{module_path}.{function_name}"
    if cache_key in _loaded_tool_funcs:
        return _loaded_tool_funcs[cache_key]
    
    try:
        module = importlib.import_module(module_path)
        func = getattr(module, function_name, None)
        if func:
            _loaded_tool_funcs[cache_key] = func
        return func
    except ImportError:
        return None


# ─── Tool Registry Manager ──────────────────────────────────────────────────

class ToolRegistry:
    """
    Manages tools for a worker with Wiki.js persistence.
    
    Usage:
        registry = ToolRegistry()
        registry.load_from_wiki()  # Load all shared tools
        registry.register_tool('my_tool', my_func)  # Register locally
        registry.save_tool_to_wiki('my_tool', ...)  # Save for sharing
    """
    
    def __init__(self, hermes_agent=None):
        self.agent = hermes_agent
        self.local_tools: dict[str, Callable] = {}
        self.wiki_tools: dict[str, dict] = {}  # tool_name -> tool_def
    
    def load_from_wiki(self) -> list:
        """
        Load all tools from Wiki and register them locally.
        
        Returns list of tool names that were successfully loaded.
        """
        tools = list_tools_from_wiki()
        loaded = []
        
        for tool_def in tools:
            tool_name = tool_def.get('name')
            func = load_tool_func(tool_def)
            
            if func:
                self.wiki_tools[tool_name] = tool_def
                self.local_tools[tool_name] = func
                if self.agent:
                    self.agent.register_tool(tool_name, func)
                loaded.append(tool_name)
        
        return loaded
    
    def save_tool(self, tool_name: str, module_path: str, function_name: str, **kwargs) -> dict:
        """
        Save a tool to Wiki and optionally register it locally.
        
        Args:
            tool_name: Name for the tool
            module_path: Python module path 
            function_name: Function name in the module
            **kwargs: Additional tool metadata (description, parameters, tags)
        
        Returns: { success: bool, message: str }
        """
        # Save to Wiki
        result = save_tool_to_wiki(
            tool_name=tool_name,
            module_path=module_path,
            function_name=function_name,
            created_by=os.environ.get('TICKET_ID'),
            **kwargs
        )
        
        if result['success']:
            # Also load it locally
            tool_def = load_tool_from_wiki(tool_name)
            if tool_def:
                func = load_tool_func(tool_def)
                if func:
                    self.wiki_tools[tool_name] = tool_def
                    self.local_tools[tool_name] = func
                    if self.agent:
                        self.agent.register_tool(tool_name, func)
        
        return result
    
    def register_local(self, tool_name: str, func: Callable, share: bool = False, **kwargs) -> dict:
        """
        Register a tool locally, optionally saving to Wiki.
        
        Args:
            tool_name: Name for the tool
            func: The function to register
            share: If True, also save to Wiki for sharing
            **kwargs: Additional tool metadata
        """
        self.local_tools[tool_name] = func
        if self.agent:
            self.agent.register_tool(tool_name, func)
        
        result = {'success': True, 'message': f"Tool '{tool_name}' registered locally"}
        
        if share:
            # Try to determine module and function name
            module_path = func.__module__
            function_name = func.__name__
            wiki_result = self.save_tool(tool_name, module_path, function_name, **kwargs)
            result['wiki'] = wiki_result
        
        return result
    
    def unregister_tool(self, tool_name: str, delete_from_wiki: bool = False) -> dict:
        """
        Unregister a tool locally and optionally from Wiki.
        """
        if tool_name in self.local_tools:
            del self.local_tools[tool_name]
        
        if tool_name in self.wiki_tools:
            del self.wiki_tools[tool_name]
        
        if self.agent and tool_name in self.agent.tools:
            del self.agent.tools[tool_name]
        
        result = {'success': True, 'message': f"Tool '{tool_name}' unregistered locally"}
        
        if delete_from_wiki:
            wiki_result = delete_tool_from_wiki(tool_name)
            result['wiki_delete'] = wiki_result
        
        return result
    
    def list_local_tools(self) -> list:
        """List all locally registered tools"""
        return list(self.local_tools.keys())
    
    def list_wiki_tools(self) -> list:
        """List all tools available from Wiki"""
        return list(self.wiki_tools.keys())


# ─── Singleton instance ─────────────────────────────────────────────────────

_registry_instance: Optional[ToolRegistry] = None


def get_tool_registry(hermes_agent=None) -> ToolRegistry:
    """Get or create the singleton ToolRegistry instance"""
    global _registry_instance
    if _registry_instance is None:
        _registry_instance = ToolRegistry(hermes_agent)
    return _registry_instance


# ─── Convenience Functions ──────────────────────────────────────────────────

def init_tool_registry(hermes_agent=None) -> ToolRegistry:
    """
    Initialize the tool registry and load tools from Wiki.
    Call this during worker startup.
    """
    registry = get_tool_registry(hermes_agent)
    registry.load_from_wiki()
    return registry
