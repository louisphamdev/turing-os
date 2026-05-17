"""
Command Executor — Handles structured commands from admin via Matrix

Executes commands injected by the orchestrator's intent parser:
- register_tool: Dynamically add a tool to the agent
- unregister_tool: Remove a tool from the agent
- update_config: Update agent configuration (max_iterations, etc.)
- set_system_prompt: Update the system prompt
- reload_role: Reload role spec from wiki
- inspect: Query and report current worker state
- save_tool: Save a tool to Wiki for sharing
- load_tools: Load shared tools from Wiki
- delete_tool: Delete a tool from Wiki
"""

import json
import time
import importlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent.hermes_loop import HermesAgent

# ─── Tool Registry — Dynamic Tool Loading ─────────────────────────────────

# Cache for dynamically loaded tools
_dyn_tools: dict = {}

# Singleton tool registry
_tool_registry = None


def _get_tool_registry(agent=None):
    """Get or create the tool registry singleton"""
    global _tool_registry
    if _tool_registry is None:
        from tools.tool_registry import ToolRegistry
        _tool_registry = ToolRegistry(agent)
    return _tool_registry


def execute_worker_command(
    agent: 'HermesAgent',
    command_type: str,
    command_args: dict,
    sender: str,
) -> str:
    """
    Execute a structured command from admin.
    Returns a confirmation message to send back to admin via Matrix.
    """
    handlers = {
        'register_tool': _handle_register_tool,
        'unregister_tool': _handle_unregister_tool,
        'update_config': _handle_update_config,
        'set_system_prompt': _handle_set_system_prompt,
        'reload_role': _handle_reload_role,
        'reload_skills': _handle_reload_skills,
        'inspect': _handle_inspect,
        'save_tool': _handle_save_tool,
        'load_tools': _handle_load_tools,
        'delete_tool': _handle_delete_tool,
    }

    handler = handlers.get(command_type)
    if not handler:
        return f"❓ Unknown command type: `{command_type}`"

    try:
        return handler(agent, command_args, sender)
    except Exception as e:
        return f"❌ Command `{command_type}` failed: {str(e)[:300]}"


# ─── Command Handlers ──────────────────────────────────────────────────────

def _handle_register_tool(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Register a new tool dynamically.
    
    Args:
        tool_name: Name of the tool to register
        tool_code_url: Optional URL to fetch tool code from (future)
        tool_description: Optional description for the tool
        tool_module: Optional module path (e.g., 'mymodule')
        tool_function: Optional function name to import
    """
    tool_name = args.get('tool_name')
    if not tool_name:
        return "❌ `tool_name` is required"

    # Check if tool already exists
    if tool_name in agent.tools:
        return f"⚠️ Tool `{tool_name}` is already registered. Use `unregister_tool` first."

    # ─── Try loading from known tool modules ───────────────────────────────
    tool_func = _try_load_tool_function(tool_name, args)
    if tool_func is None:
        return f"❌ Could not find tool: `{tool_name}`. Available options: `grep_search`, `file_search`, `fetch_webpage`, `mcp_*` tools."

    # Register the tool
    agent.register_tool(tool_name, tool_func)
    
    return (
        f"✅ Tool `{tool_name}` registered successfully.\n"
        f"📋 It is now available to the agent."
    )


def _handle_unregister_tool(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """Remove a tool from the agent."""
    tool_name = args.get('tool_name')
    if not tool_name:
        return "❌ `tool_name` is required"

    if tool_name not in agent.tools:
        return f"⚠️ Tool `{tool_name}` is not registered."

    # Prevent removing critical tools
    critical_tools = ['ask_admin', 'notify_admin', 'poll_admin_inbox']
    if tool_name in critical_tools:
        return f"🚫 Cannot unregister critical tool: `{tool_name}`"

    del agent.tools[tool_name]
    if tool_name in agent.tool_docs:
        del agent.tool_docs[tool_name]

    return f"✅ Tool `{tool_name}` removed."


def _handle_update_config(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Update agent configuration.
    
    Args:
        max_iterations: int — max reasoning iterations
        tool_timeout: int — tool execution timeout in seconds
        model: str — LLM model name (requires re-init)
        base_url: str — LLM base URL (requires re-init)
    """
    updated = []
    
    if 'max_iterations' in args:
        val = args['max_iterations']
        if isinstance(val, int) and val > 0:
            agent.max_iterations = val
            updated.append(f"max_iterations={val}")
        else:
            return f"❌ `max_iterations` must be a positive integer, got: {val}"

    if 'tool_timeout' in args:
        val = args['tool_timeout']
        if isinstance(val, int) and val > 0:
            agent.tool_timeout = val
            updated.append(f"tool_timeout={val}s")
        else:
            return f"❌ `tool_timeout` must be a positive integer, got: {val}"

    if not updated:
        return "⚠️ No valid config updates provided. Available: `max_iterations`, `tool_timeout`"

    return f"✅ Config updated: {', '.join(updated)}"


def _handle_set_system_prompt(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """Update the agent's system prompt override."""
    new_prompt = args.get('prompt')
    if not new_prompt:
        return "❌ `prompt` is required"

    agent.system_prompt_override = new_prompt
    return f"✅ System prompt updated ({len(new_prompt)} chars). Will apply to next conversation."


def _handle_reload_role(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Reload role spec from wiki.
    
    Args:
        role_spec_url: Optional URL to custom role spec
    """
    import os
    from tools import bookstack_tools as wiki_tools

    role = os.environ.get('ROLE', 'default')
    
    # If custom URL provided, use it
    role_url = args.get('role_spec_url')
    if role_url:
        try:
            content = wiki_tools.read_page(role_url)
            if content:
                agent.system_prompt_override = content
                return f"✅ Role spec reloaded from custom URL ({len(content)} chars)"
        except Exception as e:
            return f"❌ Failed to load from URL: {str(e)[:200]}"

    # Default: reload from standard wiki location
    default_urls = [
        f"/roles/{role}",
        f"/roles/{role}.md",
        f"/agent-role-{role}",
    ]

    for url in default_urls:
        try:
            content = wiki_tools.read_page(url)
            if content:
                agent.system_prompt_override = content
                return f"✅ Role spec reloaded for `{role}` from wiki ({len(content)} chars)"
        except Exception:
            continue

    return f"⚠️ Could not find role spec for `{role}` in wiki. No changes made."


def _handle_reload_skills(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Reload skills from skills.sh based on role or custom list.
    
    Args:
        skills: Optional comma-separated skill names (uses role defaults if not specified)
    """
    import os
    from tools.research_tools import load_skills_for_task_sync
    
    custom_skills = args.get('skills')
    role = os.environ.get('ROLE', 'default')
    
    if custom_skills:
        skills_to_load = custom_skills
    else:
        # Use role-based defaults
        role_skills = {
            'software-engineer': 'python,javascript,git,docker,sql',
            'po': 'product-management,agile,jira',
            'pm': 'project-management,scrum,asana',
            'hr': 'recruiting,onboarding,hr-software',
            'qa': 'testing,selenium,jest,cypress',
            'devops': 'docker,kubernetes,terraform,ci-cd',
            'ba': 'data-analysis,sql,excel',
            'data': 'python,sql,pandas,jupyter',
            'security': 'security-audit,owasp,pen-testing',
            'network': 'networking,dns,tcp-ip',
            'doctor': 'medical-knowledge,diagnostics',
        }
        skills_to_load = role_skills.get(role.lower(), 'python,javascript,git')
    
    result = load_skills_for_task_sync(skills_to_load)
    loaded = result.get('loaded', 0)
    total = result.get('total', 0)
    
    return f"✅ Reloaded {loaded}/{total} skills: {skills_to_load}"


def _handle_inspect(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Query and report current worker state.
    
    Args:
        query: What to inspect — "tools", "config", "role", "wiki_tools", or "all"
    """
    query = args.get('query', 'all')
    lines = ["📊 **Worker State Report**", ""]

    if query in ('all', 'config'):
        lines.extend([
            "**Configuration:**",
            f"  • Ticket ID: `{agent.ticket_id}`",
            f"  • Role: `{agent.role}`",
            f"  • Model: `{agent.model}`",
            f"  • Base URL: `{agent.base_url}`",
            f"  • Max iterations: `{agent.max_iterations}`",
            f"  • Tool timeout: `{agent.tool_timeout}s`",
            f"  • Messages in history: `{len(agent.messages)}`",
            f"  • Current iteration: `{agent.context.get('iteration', 0)}`",
            "",
        ])

    if query in ('all', 'tools'):
        tool_names = sorted(agent.tools.keys())
        critical = ['ask_admin', 'notify_admin', 'poll_admin_inbox']
        critical_active = [t for t in tool_names if t in critical]
        custom = [t for t in tool_names if t not in critical]
        
        lines.extend([
            f"**Tools ({len(tool_names)} total):**",
            f"  • Critical: `{', '.join(critical_active) or 'none'}`",
            f"  • Custom/Registered: `{', '.join(custom) or 'none'}`",
            "",
        ])

    if query in ('all', 'wiki_tools'):
        from tools import tool_registry as tr
        wiki_tools_list = tr.list_tools_from_wiki()
        if wiki_tools_list:
            wiki_tool_names = [t.get('name') for t in wiki_tools_list]
            lines.extend([
                f"**Shared Tools in Wiki ({len(wiki_tools_list)}):**",
                f"  • `{', '.join(wiki_tool_names)}`",
                "",
            ])
        else:
            lines.extend([
                "**Shared Tools in Wiki:** none",
                "",
            ])

    if query in ('all', 'role'):
        lines.extend([
            "**Role:**",
            f"  • Current role: `{agent.role}`",
            f"  • System prompt override: `{'set' if agent.system_prompt_override else 'not set'}`",
            "",
        ])

    if query == 'all':
        lines.append(f"Report generated at: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    return "\n".join(lines)


def _handle_save_tool(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Save a tool to BookStack for sharing across workers.
    
    Args:
        tool_name: Name for the tool (required)
        tool_module: Python module path (required)
        tool_function: Function name in the module (required)
        description: Optional description
        tags: Optional list of tags
    """
    tool_name = args.get('tool_name')
    tool_module = args.get('tool_module')
    tool_function = args.get('tool_function')
    description = args.get('description', '')
    tags = args.get('tags', [])

    if not tool_name or not tool_module or not tool_function:
        return "❌ `tool_name`, `tool_module`, and `tool_function` are required"

    # Get the function first to validate it exists
    func = None
    try:
        module = importlib.import_module(tool_module)
        func = getattr(module, tool_function, None)
    except ImportError as e:
        return f"❌ Module `{tool_module}` not found: {str(e)[:100]}"

    if func is None:
        return f"❌ Function `{tool_function}` not found in module `{tool_module}`"

    # Save to Wiki
    registry = _get_tool_registry(agent)
    result = registry.save_tool(
        tool_name=tool_name,
        module_path=tool_module,
        function_name=tool_function,
        description=description,
        tags=tags,
    )

    if result['success']:
        return (
            f"✅ Tool `{tool_name}` saved to Wiki.\n"
            f"📁 Path: `{result.get('page_path', '/tools/' + tool_name)}`\n"
            f"🔧 Other workers can now load this tool."
        )
    else:
        return f"❌ Failed to save tool: {result.get('message', 'Unknown error')}"


def _handle_load_tools(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Load shared tools from BookStack.
    
    Args:
        tool_names: Optional list of specific tools to load (loads all if not specified)
    """
    registry = _get_tool_registry(agent)
    loaded = registry.load_from_wiki()

    if loaded:
        return (
            f"✅ Loaded {len(loaded)} tools from Wiki:\n"
            f"  • `{', '.join(loaded)}`"
        )
    else:
        return "ℹ️ No shared tools found in Wiki, or Wiki not configured."


def _handle_delete_tool(agent: 'HermesAgent', args: dict, sender: str) -> str:
    """
    Delete a tool from BookStack.
    
    Args:
        tool_name: Name of the tool to delete (required)
    """
    tool_name = args.get('tool_name')
    if not tool_name:
        return "❌ `tool_name` is required"

    from tools import tool_registry as tr
    result = tr.delete_tool_from_wiki(tool_name)

    if result['success']:
        # Also unregister locally if present
        if tool_name in agent.tools:
            del agent.tools[tool_name]
        return f"✅ Tool `{tool_name}` deleted from Wiki."
    else:
        return f"❌ Failed to delete: {result.get('message', 'Unknown error')}"


# ─── Dynamic Tool Loading ──────────────────────────────────────────────────

def _try_load_tool_function(tool_name: str, args: dict):
    """
    Try to load a tool function from known sources.
    Returns the function if found, None otherwise.
    """
    global _dyn_tools

    # Check cache first
    if tool_name in _dyn_tools:
        return _dyn_tools[tool_name]

    # ─── Try Wiki first (shared tools) ───────────────────────────────────
    try:
        from tools import tool_registry as tr
        wiki_tool = tr.load_tool_from_wiki(tool_name)
        if wiki_tool:
            func = tr.load_tool_func(wiki_tool)
            if func:
                _dyn_tools[tool_name] = func
                return func
    except Exception:
        pass

    # ─── Built-in tool mappings ──────────────────────────────────────────
    builtin_tools = {
        # Local exec tools
        'grep_search': ('tools.local_exec', 'grep_search'),
        'file_search': ('tools.local_exec', 'file_search'),
        'run_terminal': ('tools.local_exec', 'execute_terminal_command'),
        
        # Matrix tools
        'send_matrix_message': ('tools.matrix_tools', 'send_matrix_message'),
        'get_matrix_messages': ('tools.matrix_tools', 'get_matrix_messages'),
        
        # Web / research
        'fetch_webpage': ('tools.research_tools', 'fetch_webpage_sync'),
        'web_search': ('tools.research_tools', 'web_search_sync'),
        
        # File tools
        'list_directory': ('tools.local_exec', 'list_directory'),
        'create_file': ('tools.local_exec', 'write_file'),
    }

    # ─── Try built-in mappings ────────────────────────────────────────────
    if tool_name in builtin_tools:
        module_path, func_name = builtin_tools[tool_name]
        try:
            module = importlib.import_module(module_path)
            func = getattr(module, func_name, None)
            if func:
                _dyn_tools[tool_name] = func
                return func
        except ImportError:
            pass

    # ─── Try MCP tools (pylance) ─────────────────────────────────────────
    if tool_name.startswith('mcp_pylance_') or 'pylance' in tool_name.lower():
        return _load_pylance_tool(tool_name, args)

    # ─── Try module.function syntax ───────────────────────────────────────
    tool_module = args.get('tool_module')
    tool_function = args.get('tool_function', tool_name)
    if tool_module:
        try:
            module = importlib.import_module(tool_module)
            func = getattr(module, tool_function, None)
            if func:
                _dyn_tools[tool_name] = func
                return func
        except ImportError:
            pass

    # ─── No tool found ─────────────────────────────────────────────────────
    return None


def _load_pylance_tool(tool_name: str, args: dict):
    """
    Load a Pylance MCP tool dynamically.
    
    Tools follow the pattern: mcp_pylance_mcp_s_<toolName>
    e.g., mcp_pylance_mcp_s_pylanceDocuments
    """
    global _dyn_tools

    # Map tool names to their Python function names
    pylance_tool_map = {
        'mcp_pylance_mcp_s_pylanceDocuments': (
            'mcp_pylance_mcp_s_pylanceDocuments', 
            'pylance_search'
        ),
        'mcp_pylance_mcp_s_pylanceSettings': (
            'mcp_pylance_mcp_s_pylanceSettings',
            'get_settings'
        ),
        'pylance_workspace_roots': (
            'mcp_pylance_mcp_s_pylanceWorkspaceRoots',
            'workspace_roots'
        ),
    }

    if tool_name in pylance_tool_map:
        module_name, func_name = pylance_tool_map[tool_name]
        try:
            def pylance_wrapper(**kwargs):
                """Pylance MCP tool wrapper - requires Pylance MCP server"""
                return {
                    'tool': tool_name,
                    'status': 'not_implemented',
                    'note': 'Pylance MCP tools require the Pylance MCP server connection'
                }
            
            _dyn_tools[tool_name] = pylance_wrapper
            return pylance_wrapper
        except Exception as e:
            return None

    # Generic MCP tool wrapper
    def generic_mcp_wrapper(**kwargs):
        """Generic MCP tool wrapper"""
        return {
            'tool': tool_name,
            'args': kwargs,
            'status': 'placeholder',
            'note': 'MCP tool - implement with actual MCP client'
        }

    _dyn_tools[tool_name] = generic_mcp_wrapper
    return generic_mcp_wrapper
