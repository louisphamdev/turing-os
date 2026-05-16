"""
Tool Registry — Persistent Tool Storage via BookStack

Provides persistent, shared tool storage across workers:
- Tools are stored in BookStack as JSON in page content
- Workers load tools from BookStack on startup
- New tools can be saved to BookStack for sharing
- Tool definitions include: name, description, module, function, parameters

Storage format (BookStack page):
  Page name: /tools/{tool_name}
  Page content: JSON with tool definition
"""

import os
import json
import importlib
import requests
from datetime import datetime
from typing import Optional, Callable, Any

BOOKSTACK_URL = os.environ.get('BOOKSTACK_URL', 'http://bookstack:80')
BOOKSTACK_TOKEN = os.environ.get('BOOKSTACK_TOKEN', '')

# ─── BookStack Tool Storage ────────────────────────────────────────────────────

TOOLS_BOOK_NAME = 'Turing OS Tools'
TOOLS_SHELF_NAME = 'Turing OS'


def _bs_request(method: str, endpoint: str, data: dict = None, params: dict = None) -> dict:
    """Make REST request to BookStack API"""
    url = f"{BOOKSTACK_URL}/api/{endpoint.lstrip('/')}"
    headers = {
        'Authorization': f'Token {BOOKSTACK_TOKEN}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }

    if not BOOKSTACK_TOKEN:
        return {'error': 'BOOKSTACK_TOKEN not configured'}

    try:
        if method.upper() == 'GET':
            resp = requests.get(url, headers=headers, params=params, timeout=15)
        elif method.upper() == 'POST':
            resp = requests.post(url, headers=headers, json=data, timeout=15)
        elif method.upper() == 'PUT':
            resp = requests.put(url, headers=headers, json=data, timeout=15)
        elif method.upper() == 'DELETE':
            resp = requests.delete(url, headers=headers, timeout=15)
        else:
            return {'error': f'Unsupported HTTP method: {method}'}

        resp.raise_for_status()
        if resp.content:
            return resp.json()
        return {'success': True}
    except requests.exceptions.HTTPError as e:
        try:
            return {'error': e.response.json().get('message', str(e))}
        except (ValueError, AttributeError):
            return {'error': str(e)}
    except Exception as e:
        return {'error': str(e)}


def _ensure_shelf_and_book() -> tuple:
    """Ensure the shelf and book exist for storing tools. Returns (book_id, shelf_id)."""
    shelves = _bs_request('GET', 'shelves', params={'count': 100})
    if 'error' in shelves:
        return {}, None

    shelf_id = None
    for shelf in shelves.get('data', []):
        if shelf.get('name') == TOOLS_SHELF_NAME:
            shelf_id = shelf.get('id')
            break

    if not shelf_id:
        result = _bs_request('POST', 'shelves', data={'name': TOOLS_SHELF_NAME, 'description': 'Turing OS shared tools'})
        if 'error' not in result:
            shelf_id = result.get('shelf', result).get('id')

    books = _bs_request('GET', 'books', params={'count': 100})
    if 'error' in books:
        return {}, shelf_id

    book_id = None
    for book in books.get('data', []):
        if book.get('name') == TOOLS_BOOK_NAME:
            book_id = book.get('id')
            break

    if not book_id:
        result = _bs_request('POST', 'books', data={
            'name': TOOLS_BOOK_NAME,
            'description': 'Shared tool definitions for Turing OS workers',
            'shelf_id': shelf_id
        })
        if 'error' not in result:
            book_id = result.get('book', result).get('id')

    return book_id, shelf_id


def _find_page_by_name(name: str, book_id: int) -> Optional[dict]:
    """Find a page in a book by name"""
    pages = _bs_request('GET', f'books/{book_id}/pages', params={'count': 100})
    if 'error' in pages:
        return None

    for page in pages.get('data', []):
        if page.get('name') == name:
            page_detail = _bs_request('GET', f'pages/{page.get("id")}')
            if 'error' not in page_detail:
                return page_detail.get('page', page_detail)
            return page
    return None


def _create_or_update_page(name: str, content: str, book_id: int, chapter_id: int = None) -> dict:
    """Create or update a page in BookStack"""
    existing = _find_page_by_name(name, book_id)

    if existing:
        page_id = existing.get('id')
        return _bs_request('PUT', f'pages/{page_id}', data={
            'name': name,
            'markdown': content,
        })
    else:
        data = {
            'book_id': book_id,
            'name': name,
            'markdown': content,
        }
        if chapter_id:
            data['chapter_id'] = chapter_id
        return _bs_request('POST', 'pages', data=data)


def list_tools_from_wiki() -> list:
    """List all shared tools stored in BookStack."""
    if not BOOKSTACK_TOKEN:
        print("[ToolRegistry] WARNING: BOOKSTACK_TOKEN not configured")
        return []

    book_id, _ = _ensure_shelf_and_book()
    if not book_id:
        return []

    tools = []
    pages = _bs_request('GET', f'books/{book_id}/pages', params={'count': 100})
    if 'error' in pages:
        return []

    for page in pages.get('data', []):
        page_detail = _bs_request('GET', f'pages/{page.get("id")}')
        if 'error' in page_detail:
            continue

        page_data = page_detail.get('page', {})
        content = page_data.get('markdown', '')

        try:
            if content.startswith('```'):
                lines = content.split('\n')
                content = '\n'.join(lines[1:-1])
            tool_def = json.loads(content)
            if isinstance(tool_def, dict) and 'name' in tool_def:
                tools.append(tool_def)
        except (json.JSONDecodeError, ValueError):
            pass

    return tools


def load_tool_from_wiki(tool_name: str) -> Optional[dict]:
    """Load a single tool definition by name."""
    if not BOOKSTACK_TOKEN:
        return None

    book_id, _ = _ensure_shelf_and_book()
    if not book_id:
        return None

    page = _find_page_by_name(f'/tools/{tool_name}'"'", book_id)
    if not page:
        return None

    content = page.get('markdown', '')
    try:
        if content.startswith('```'):
            lines = content.split('\n')
            content = '\n'.join(lines[1:-1])
        return json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return None


def save_tool_to_wiki(
    tool_name: str,
    module_path: str,
    function_name: str,
    created_by: str = None,
    description: str = "",
    tags: list = None,
    parameters: dict = None,
) -> dict:
    """Save a tool definition to BookStack."""
    if not BOOKSTACK_TOKEN:
        return {'success': False, 'message': 'BOOKSTACK_TOKEN not configured'}

    book_id, _ = _ensure_shelf_and_book()
    if not book_id:
        return {'success': False, 'message': 'Could not create/find tools book'}

    tool_def = {
        "name": tool_name,
        "description": description or f"Tool {tool_name}",
        "module": module_path,
        "function": function_name,
        "parameters": parameters or {},
        "tags": tags or ["turing-tool", "shared"],
        "created_by": created_by or "unknown",
        "created_at": __import__('datetime').datetime.now().isoformat(),
    }

    content = json.dumps(tool_def, indent=2)
    result = _create_or_update_page(f'/tools/{tool_name}'"'", content, book_id)

    if 'error' in result:
        return {'success': False, 'message': f"Save failed: {result['error']}"}

    return {'success': True, 'message': f"Tool '{tool_name}' saved to BookStack"}


def delete_tool_from_wiki(tool_name: str) -> dict:
    """Delete a tool from BookStack."""
    if not BOOKSTACK_TOKEN:
        return {'success': False, 'message': 'BOOKSTACK_TOKEN not configured'}

    book_id, _ = _ensure_shelf_and_book()
    if not book_id:
        return {'success': False, 'message': 'Could not find tools book'}

    page = _find_page_by_name(f'/tools/{tool_name}'"'", book_id)
    if not page:
        return {'success': False, 'message': f"Tool '{tool_name}' not found"}

    result = _bs_request('DELETE', f'pages/{page.get("id")}')
    if 'error' in result:
        return {'success': False, 'message': f"Delete failed: {result['error']}"}

    return {'success': True, 'message': f"Tool '{tool_name}' deleted from BookStack"}


_loaded_tool_funcs: dict = {}


def load_tool_func(tool_def: dict) -> Optional[Callable]:
    """Load and return a tool function from its BookStack definition."""
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


class ToolRegistry:
    """Manages tools for a worker with BookStack persistence."""

    def __init__(self, hermes_agent=None):
        self.agent = hermes_agent
        self.local_tools: dict[str, Callable] = {}
        self.wiki_tools: dict[str, dict] = {}

    def load_from_wiki(self) -> list:
        """Load all tools from BookStack and register them locally."""
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
        """Save a tool to BookStack and optionally register it locally."""
        result = save_tool_to_wiki(
            tool_name=tool_name,
            module_path=module_path,
            function_name=function_name,
            created_by=os.environ.get('TICKET_ID'),
            **kwargs
        )

        if result['success']:
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
        """Register a tool locally, optionally saving to BookStack."""
        self.local_tools[tool_name] = func
        if self.agent:
            self.agent.register_tool(tool_name, func)

        result = {'success': True, 'message': f"Tool '{tool_name}' registered locally"}

        if share:
            module_path = func.__module__
            function_name = func.__name__
            wiki_result = self.save_tool(tool_name, module_path, function_name, **kwargs)
            result['wiki'] = wiki_result

        return result

    def unregister_tool(self, tool_name: str, delete_from_wiki: bool = False) -> dict:
        """Unregister a tool locally and optionally from BookStack."""
        if tool_name in self.local_tools:
            del self.local_tools[tool_name]

        if tool_name in self.wiki_tools:
            del self.wiki_tools[tool_name]

        if self.agent and tool_name in getattr(self.agent, 'tools', {}):
            del self.agent.tools[tool_name]

        if delete_from_wiki:
            return delete_tool_from_wiki(tool_name)

        return {'success': True, 'message': f"Tool '{tool_name}' unregistered"}
