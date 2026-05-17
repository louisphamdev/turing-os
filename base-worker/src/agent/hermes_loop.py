"""
Hermes Agent - ReAct Loop with Tool Calling
The core reasoning engine that drives worker behavior.

Supports both text-based tool calling (TOOL_CALL format) and
native LLM function calling where available.

Gateway Mode:
When GATEWAY_ENABLED=true, LLM calls are routed through the Turing OS
gateway proxy using consumer tokens instead of direct API access.
"""

import os
import json
import re
import asyncio
import time
import requests
from typing import Any, Callable, Optional
from dataclasses import dataclass, field


@dataclass
class ToolResult:
    """Result from a tool execution"""
    success: bool
    result: Any
    error: Optional[str] = None


@dataclass
class ToolCall:
    """A parsed tool call from LLM response"""
    name: str
    arguments: dict


@dataclass
class AgentMessage:
    """A message in the agent's conversation history"""
    role: str  # 'user', 'assistant', 'tool', 'system'
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)


class HermesAgent:
    """
    ReAct (Reasoning + Acting) Agent with Tool Calling capability.

    The agent maintains a conversation history and iteratively:
    1. Thinks about what action to take
    2. Selects and calls a tool
    3. Observes the result
    4. Repeats until task is complete
    """

    def __init__(
        self,
        ticket_id: str,
        role: str = "default",
        api_key: Optional[str] = None,
        max_iterations: int = 15,
        tool_timeout: int = 60,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        checkpoint_manager=None,
    ):
        self.ticket_id = ticket_id
        self.role = role
        self.api_key = api_key or os.environ.get('LLM_API_KEY')
        self.max_iterations = max_iterations
        self.tool_timeout = tool_timeout
        self.model = model or os.environ.get('LLM_MODEL', 'gpt-4o')
        self.base_url = base_url or os.environ.get('LLM_BASE_URL', 'https://api.openai.com/v1')
        self.checkpoint_manager = checkpoint_manager

        self.tools: dict[str, Callable] = {}
        self.tool_docs: dict[str, str] = {}
        self.messages: list[AgentMessage] = []
        self.context: dict = {
            'ticket_id': ticket_id,
            'role': role,
            'iteration': 0
        }

        # Load default tools
        self._register_default_tools()

    def _register_default_tools(self):
        """Register the built-in tools"""
        from tools import state_backend, bookstack_tools as wiki_tools, local_exec, research_tools, matrix_tools

        self.register_tool('update_ticket_status', state_backend.update_ticket_status)
        self.register_tool('read_ticket', state_backend.read_ticket)
        self.register_tool('add_comment', state_backend.add_comment)
        self.register_tool('create_ticket', state_backend.create_ticket)
        self.register_tool('search_tickets', state_backend.search_tickets)
        self.register_tool('execute_terminal_command', local_exec.execute_terminal_command)
        self.register_tool('read_file', local_exec.read_file)
        self.register_tool('write_file', local_exec.write_file)
        self.register_tool('read_document', wiki_tools.read_page)
        self.register_tool('search_documents', wiki_tools.search_pages)
        self.register_tool('list_documents', wiki_tools.list_pages)
        self.register_tool('write_document', wiki_tools.update_page)

        # Research tools
        self.register_tool('load_skills_for_task', research_tools.load_skills_for_task_sync)
        self.register_tool('research_with_context7', research_tools.research_with_context7_sync)
        self.register_tool('get_research_capabilities', research_tools.get_research_capabilities)

        # Matrix communication tools (bidirectional admin ↔ worker, via
        # the orchestrator relay — these route through /webhooks/worker-message
        # and /webhooks/worker-inbox/* with the worker's CONSUMER_TOKEN).
        self.register_tool('ask_admin', matrix_tools.ask_admin)
        self.register_tool('notify_admin', matrix_tools.notify_admin)
        self.register_tool('poll_admin_inbox', matrix_tools.poll_admin_inbox)
        # Direct Matrix tools (send_matrix_message / get_matrix_messages) are
        # intentionally NOT registered: workers must never speak Matrix with
        # admin credentials. Use ask_admin/notify_admin instead.

        # PM monitoring tools (for pm role to proactively monitor project)
        from tools import pm_monitor
        self.register_tool('get_workers_health', pm_monitor.get_workers_health)
        self.register_tool('get_stuck_workers', pm_monitor.get_stuck_workers)
        self.register_tool('get_queue_status', pm_monitor.get_queue_status)
        self.register_tool('detect_stuck_workers', pm_monitor.detect_stuck_workers)
        self.register_tool('report_project_health', pm_monitor.report_project_health)
        self.register_tool('check_dependency_wait', pm_monitor.check_dependency_wait)
        self.register_tool('get_high_priority_tasks', pm_monitor.get_high_priority_tasks)

        # Doctor diagnostic & self-healing tools
        from tools import doctor_tools
        self.register_tool('check_system_health', doctor_tools.check_system_health)
        self.register_tool('parse_docker_logs', doctor_tools.parse_docker_logs)
        self.register_tool('check_service_connectivity', doctor_tools.check_service_connectivity)
        self.register_tool('check_recent_errors', doctor_tools.check_recent_errors)
        self.register_tool('query_known_issues_db', doctor_tools.query_known_issues_db)
        self.register_tool('save_to_known_issues', doctor_tools.save_to_known_issues)
        self.register_tool('create_github_issue', doctor_tools.create_github_issue)
        self.register_tool('run_fix_script', doctor_tools.run_fix_script)
        self.register_tool('track_metrics', doctor_tools.track_metrics)
        self.register_tool('get_doctor_dashboard', doctor_tools.get_doctor_dashboard)
        self.register_tool('ask_user_confirmation', doctor_tools.ask_user_confirmation)
        self.register_tool('report_fix_success', doctor_tools.report_fix_success)
        self.register_tool('report_fix_failure', doctor_tools.report_fix_failure)
        self.register_tool('run_self_healing_pipeline', doctor_tools.run_self_healing_pipeline)
        self.register_tool('run_full_remediation', doctor_tools.run_full_remediation)
        self.register_tool('create_dynamic_fix_script', doctor_tools.create_dynamic_fix_script)
        self.register_tool('patch_config_file', doctor_tools.patch_config_file)
        self.register_tool('invoke_worker_tool', doctor_tools.invoke_worker_tool)
        # Container discovery tools — Doctor can now see ALL containers & workers
        self.register_tool('list_docker_containers', doctor_tools.list_docker_containers)
        self.register_tool('get_container_inspect', doctor_tools.get_container_inspect)
        self.register_tool('tail_container_logs', doctor_tools.tail_container_logs)
        self.register_tool('find_containers_by_role', doctor_tools.find_containers_by_role)

        # PM health & failover tools — Doctor manages PM failover
        self.register_tool('check_pm_health', doctor_tools.check_pm_health)
        self.register_tool('check_pm_queue_state', doctor_tools.check_pm_queue_state)
        self.register_tool('check_pm_failover_readiness', doctor_tools.check_pm_failover_readiness)

        # Initialize research tools with API key from environment
        research_tools.init_research_tools()

        # ─── Checkpoint / Recovery Tools ─────────────────────────────────
        from checkpoint import CheckpointManager
        self._checkpoint_manager = None  # Set externally via set_checkpoint_manager()
        self.register_tool('save_checkpoint', self._save_checkpoint_tool)
        self.register_tool('load_checkpoint', self._load_checkpoint_tool)
        self.register_tool('clear_checkpoint', self._clear_checkpoint_tool)

    def register_tool(self, name: str, func: Callable):
        """Register a tool function"""
        self.tools[name] = func
        self.tool_docs[name] = func.__doc__ or "No description"
        self.system_prompt_override = None  # For interactive mode

    def register_tools(self, tools: dict[str, Callable]):
        """Register multiple tools at once"""
        for name, func in tools.items():
            self.register_tool(name, func)

    def run_interactive(self, user_message: str) -> tuple:
        """
        Run agent in interactive chat mode with custom system prompt.
        Returns tuple of (result_str, response_content)
        """
        print(f"[Hermes] Starting interactive session for role: {self.role}")

        # Use custom system prompt if set
        if self.system_prompt_override:
            system_prompt = self.system_prompt_override
        else:
            system_prompt = self._build_system_prompt()
        
        self.messages.append(AgentMessage(role='system', content=system_prompt))
        self._add_message('user', user_message)

        for iteration in range(self.max_iterations):
            self.context['iteration'] = iteration + 1
            print(f"\n[Hermes] ── Iteration {self.context['iteration']}/{self.max_iterations} ──")

            try:
                response = self._call_llm()
            except Exception as e:
                print(f"[Hermes] LLM call failed: {e}")
                return ('blocked', None)

            content = response.get('content', '') or response.get('text', '')
            self._add_message('assistant', content)

            # For interactive mode, return the response content
            if iteration == 0 and content:
                print(f"[Hermes] ✓ Response generated")
                return ('done', content)

            # Parse and execute tool calls
            tool_calls = self._parse_tool_calls(response)

            if not tool_calls:
                print("[Hermes] No tool calls in response, continuing...")
                if iteration == self.max_iterations - 1:
                    return ('done', content)  # Return content even without tools
                continue

            for tool_call in tool_calls:
                result = self._execute_tool(tool_call)
                result_str = str(result.result) if result.success else f"ERROR: {result.error}"
                if len(result_str) > 4000:
                    result_str = result_str[:4000] + "\n... [truncated]"
                self._add_message('tool', f"[{tool_call.name}] {result_str}")

            if self._is_task_complete():
                print("[Hermes] ✓ Task status indicates completion")
                return ('done', content)

        print(f"[Hermes] Max iterations ({self.max_iterations}) reached")
        return ('max_iterations', None)

    def run(self, initial_task: Optional[str] = None) -> str:
        """
        Main entry point to run the agent.
        Returns 'done', 'blocked', or 'max_iterations'
        """
        print(f"[Hermes] Starting agent for ticket {self.ticket_id}, role: {self.role}")

        if initial_task:
            self.context['task'] = initial_task

        # Build and set system prompt
        system_prompt = self._build_system_prompt()
        self.messages.append(AgentMessage(role='system', content=system_prompt))

        # Add initial task as user message
        if initial_task:
            self._add_message('user', f"Execute this task:\n\n{initial_task}")

        for iteration in range(self.max_iterations):
            self.context['iteration'] = iteration + 1
            print(f"\n[Hermes] ── Iteration {self.context['iteration']}/{self.max_iterations} ──")

            # Send heartbeat to orchestrator
            self._send_heartbeat(f"iteration_{iteration + 1}")

            # Get LLM response
            try:
                response = self._call_llm()
            except Exception as e:
                print(f"[Hermes] LLM call failed: {e}")
                return 'blocked'

            content = response.get('content', '') or response.get('text', '')
            self._add_message('assistant', content)

            # Check for DONE/BLOCKED signals
            if self._check_done_signal(content):
                print("[Hermes] ✓ Task completed")
                return 'done'

            if self._check_blocked_signal(content):
                reason = self._extract_blocked_reason(content)
                print(f"[Hermes] ✗ Task blocked: {reason}")
                return 'blocked'

            # Parse and execute tool calls
            tool_calls = self._parse_tool_calls(response)

            if not tool_calls:
                print("[Hermes] No tool calls in response, continuing...")
                continue

            for tool_call in tool_calls:
                result = self._execute_tool(tool_call)
                # Add tool result as a message
                result_str = str(result.result) if result.success else f"ERROR: {result.error}"
                # Truncate very long results
                if len(result_str) > 4000:
                    result_str = result_str[:4000] + "\n... [truncated]"
                self._add_message('tool', f"[{tool_call.name}] {result_str}")

            # ─── Auto-checkpoint every N iterations ───────────────────────
            if self.checkpoint_manager and self.checkpoint_manager.should_save(self.context['iteration']):
                self.checkpoint_manager.save(
                    self,
                    last_action=f"Completed iteration {self.context['iteration']}, last_tool={tool_calls[-1].name if tool_calls else 'none'}"
                )
            # ───────────────────────────────────────────────────────────────

            # Check if a tool updated ticket to done/blocked
            if self._is_task_complete():
                print("[Hermes] ✓ Task status indicates completion")
                return 'done'

        print(f"[Hermes] Max iterations ({self.max_iterations}) reached")
        return 'max_iterations'

    def _build_system_prompt(self) -> str:
        """Build the system prompt with available tools"""
        tools_schema = self._build_tools_schema()

        return f"""You are Hermes, an AI agent that executes tasks by calling tools.

## Your Identity
- Ticket ID: {self.ticket_id}
- Role: {self.role}

## MANDATORY: Skill Loading Before Task Execution

⚠️ BEFORE STARTING ANY TASK, you MUST load relevant skills:

```
TOOL_CALL: load_skills_for_task
ARGUMENTS: {{"skill_names": "python,fastapi,sql"}}
```

Replace skill names with the actual skills needed for your task.

⚠️ If you encounter unfamiliar frameworks, use context7 to research:

```
TOOL_CALL: research_with_context7
ARGUMENTS: {{"library_name": "fastapi", "topic": "authentication"}}
```

## Admin Communication (Matrix)

You can communicate with the admin (human) via Matrix:

- **Ask a question and wait for reply:**
```
TOOL_CALL: ask_admin
ARGUMENTS: {{"question": "Should I use PostgreSQL or MySQL?"}}
```

- **Send a notification (no reply expected):**
```
TOOL_CALL: notify_admin
ARGUMENTS: {{"message": "Starting database migration...", "message_type": "progress"}}
```

- **Check for pending admin messages:**
```
TOOL_CALL: poll_admin_inbox
ARGUMENTS: {{}}
```

Use `ask_admin` when you need human input to proceed.
Use `notify_admin` for progress updates or non-blocking notifications.

## Task
{self.context.get('task', 'Complete the assigned task.')}

## Available Tools
{tools_schema}

## Response Format
When you need to call a tool, respond with:
```
TOOL_CALL: tool_name
ARGUMENTS: {{"arg1": "value1", "arg2": "value2"}}
```

You may call multiple tools in one response.

When task is complete, respond with:
```
DONE: <summary of what was accomplished>
```

If blocked and need human intervention:
```
BLOCKED: <reason you cannot proceed>
```"""

    def _build_tools_schema(self) -> str:
        """Build tool schema for the prompt"""
        schema_parts = []
        for name, func in self.tools.items():
            doc = (func.__doc__ or "No description").strip()
            # Get first 3 lines of docstring
            doc_lines = doc.split('\n')
            brief = '\n'.join(doc_lines[:3]).strip()

            sig_lines = []
            try:
                import inspect
                sig = inspect.signature(func)
                for param_name, param in sig.parameters.items():
                    if param_name in ('self', 'cls'):
                        continue
                    ann = param.annotation
                    type_name = ann.__name__ if hasattr(ann, '__name__') else str(ann)
                    if type_name == "<class 'inspect._empty'>":
                        type_name = "any"
                    default = "" if param.default == inspect.Parameter.empty else f" = {param.default}"
                    sig_lines.append(f"  - {param_name}: {type_name}{default}")
            except (ValueError, TypeError):
                pass

            params = '\n'.join(sig_lines) if sig_lines else '  (no parameters)'
            schema_parts.append(f"### {name}\n{brief}\nParameters:\n{params}")

        return '\n\n'.join(schema_parts)

    def _add_message(self, role: str, content: str):
        """Add a message to history"""
        self.messages.append(AgentMessage(role=role, content=content))

        # Keep conversation manageable — trim old messages if too many
        max_messages = 50
        if len(self.messages) > max_messages:
            # Keep system prompt (first) + last N messages
            self.messages = [self.messages[0]] + self.messages[-(max_messages - 1):]

    def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
        """Execute a tool and return the result"""
        print(f"[Hermes] 🔧 {tool_call.name}({json.dumps(tool_call.arguments, ensure_ascii=False)[:200]})")

        if tool_call.name not in self.tools:
            return ToolResult(success=False, result=None, error=f"Unknown tool: {tool_call.name}")

        try:
            func = self.tools[tool_call.name]
            result = func(**tool_call.arguments)
            print(f"[Hermes]    → {str(result)[:200]}")
            return ToolResult(success=True, result=result)
        except Exception as e:
            print(f"[Hermes]    ✗ Error: {e}")
            return ToolResult(success=False, result=None, error=str(e))

    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Override in subclass"""
        raise NotImplementedError("Override _call_llm() with your LLM provider")

    def _parse_tool_calls(self, response: dict) -> list[ToolCall]:
        """Parse tool calls from LLM response"""
        tool_calls = []

        content = response.get('content', '') or response.get('text', '')

        # Parse text format: TOOL_CALL: tool_name\nARGUMENTS: {...}
        tool_pattern = r'TOOL_CALL:\s*(\w+)\s*\nARGUMENTS:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})'
        matches = re.finditer(tool_pattern, content, re.DOTALL)

        for match in matches:
            name = match.group(1)
            args_str = match.group(2)
            try:
                args = json.loads(args_str)
                tool_calls.append(ToolCall(name=name, arguments=args))
            except json.JSONDecodeError as e:
                print(f"[Hermes] Failed to parse arguments for {name}: {e}")
                # Try to fix common JSON issues
                try:
                    fixed = args_str.replace("'", '"')
                    args = json.loads(fixed)
                    tool_calls.append(ToolCall(name=name, arguments=args))
                except json.JSONDecodeError:
                    pass

        # Also check structured format from native tool calling
        if 'tool_calls' in response:
            for tc in response['tool_calls']:
                if isinstance(tc, dict):
                    name = tc.get('name', '')
                    if not name and 'function' in tc:
                        name = tc['function'].get('name', '')

                    args = tc.get('arguments', {})
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    elif 'function' in tc and isinstance(tc['function'].get('arguments'), str):
                        try:
                            args = json.loads(tc['function']['arguments'])
                        except json.JSONDecodeError:
                            args = {}

                    if name:
                        tool_calls.append(ToolCall(name=name, arguments=args))

        return tool_calls

    def _check_done_signal(self, content: str) -> bool:
        """Check if the response indicates task completion"""
        return bool(re.search(r'^DONE:', content, re.MULTILINE))

    def _check_blocked_signal(self, content: str) -> bool:
        """Check if the response indicates blocked state"""
        return bool(re.search(r'^BLOCKED:', content, re.MULTILINE))

    def _extract_blocked_reason(self, content: str) -> str:
        """Extract the blocked reason from content"""
        match = re.search(r'^BLOCKED:\s*(.+)', content, re.MULTILINE)
        return match.group(1).strip() if match else 'Unknown reason'

    def _is_task_complete(self) -> bool:
        """Check if the task is complete by looking at recent tool results"""
        for msg in reversed(self.messages[-5:]):
            if msg.role == 'tool':
                content_upper = msg.content.upper()
                if any(s in content_upper for s in ['STATUS.*DONE', 'STATUS.*REVIEW', '"DONE"', "'DONE'"]):
                    return True
        return False

    def _send_heartbeat(self, progress: str = ''):
        """Send heartbeat to orchestrator"""
        orchestrator_url = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
        try:
            import requests
            from orchestrator_auth import orchestrator_headers
            requests.post(
                f'{orchestrator_url}/webhooks/health/heartbeat',
                json={
                    'ticket_id': self.ticket_id,
                    'role': self.role,
                    'status': 'working',
                    'progress': progress,
                },
                headers=orchestrator_headers(),
                timeout=5,
            )
        except Exception:
            pass  # Don't fail on heartbeat errors

    def get_history(self) -> list[AgentMessage]:
        """Get the conversation history"""
        return self.messages.copy()

    # ─── Checkpoint Management ────────────────────────────────────────────

    def set_checkpoint_manager(self, checkpoint_manager):
        """Set the checkpoint manager for this agent"""
        self.checkpoint_manager = checkpoint_manager

    def _save_checkpoint_tool(self, last_action: str = '') -> dict:
        """
        Save a checkpoint of current agent state for crash recovery.
        The checkpoint captures conversation history, iteration count, and context.
        
        Use this:
        - Automatically every N iterations (built-in)
        - Manually before a risky operation
        - Before entering interactive mode (background task)
        
        Returns:
            {"success": true, "checkpoint_num": N, "iteration": N, "path": "/tmp/worker-checkpoint.json"}
        """
        if not self.checkpoint_manager:
            return {"success": False, "error": "No checkpoint manager configured"}
        
        ok = self.checkpoint_manager.save(self, last_action)
        if ok:
            return {
                "success": True,
                "checkpoint_num": self.checkpoint_manager._save_count,
                "iteration": self.context.get('iteration', 0),
                "last_action": last_action,
                "message": f"Checkpoint saved at iteration {self.context.get('iteration', 0)}"
            }
        return {"success": False, "error": "Failed to save checkpoint"}

    def _load_checkpoint_tool(self) -> dict:
        """
        Load a checkpoint and restore agent state.
        Call this immediately after creating the agent to resume from a crash.
        
        Returns:
            {"success": true, "restored": true, "iteration": N, "messages_restored": N}
            or {"success": true, "restored": false, "reason": "no checkpoint found"}
        """
        if not self.checkpoint_manager:
            return {"success": False, "error": "No checkpoint manager configured"}
        
        data = self.checkpoint_manager.load()
        if not data:
            return {"success": True, "restored": False, "reason": "no checkpoint found"}
        
        ok = self.checkpoint_manager.restore(self, data)
        if ok:
            return {
                "success": True,
                "restored": True,
                "iteration": self.context.get('iteration', 0),
                "messages_restored": len(self.messages),
            }
        return {"success": False, "error": "Failed to restore checkpoint"}

    def _clear_checkpoint_tool(self) -> dict:
        """
        Clear the checkpoint file.
        Call this after task is successfully completed.
        
        Returns:
            {"success": true}
        """
        if not self.checkpoint_manager:
            return {"success": False, "error": "No checkpoint manager configured"}
        self.checkpoint_manager.clear()
        return {"success": True}


class OpenAIAgent(HermesAgent):
    """
    Hermes agent with OpenAI GPT integration.
    Supports configurable model and base URL.
    
    Gateway Mode: When GATEWAY_ENABLED=true, routes calls through the
    Turing OS gateway proxy using consumer tokens instead of direct API.
    """

    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Call the LLM via the orchestrator gateway.

        Gateway mode is mandatory now — workers no longer hold raw API keys.
        If GATEWAY_URL or CONSUMER_TOKEN is missing the spawn was misconfigured.
        """
        gateway_url = os.environ.get('GATEWAY_URL')
        consumer_token = os.environ.get('CONSUMER_TOKEN')
        if not gateway_url or not consumer_token:
            raise RuntimeError(
                'LLM gateway is not configured (GATEWAY_URL + CONSUMER_TOKEN). '
                'Workers must be spawned with gateway mode.'
            )
        return self._call_llm_via_gateway(messages)

    def _call_llm_via_gateway(self, messages: list[AgentMessage] = None) -> dict:
        """Call LLM via Turing OS Gateway Proxy"""
        gateway_url = os.environ.get('GATEWAY_URL')
        consumer_token = os.environ.get('CONSUMER_TOKEN')

        # Convert messages to OpenAI format
        system_content = ""
        openai_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'system':
                system_content = msg.content
            elif msg.role == 'user':
                if system_content:
                    openai_messages.append({"role": "user", "content": system_content + "\n\n" + msg.content})
                    system_content = ""
                else:
                    openai_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                openai_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                openai_messages.append({"role": "user", "content": msg.content})

        # Build request for gateway
        request_body = {
            'model': self.model,
            'messages': openai_messages,
            'temperature': 0.3,
            'max_tokens': 4096,
        }

        try:
            response = requests.post(
                f"{gateway_url}/gateway/llm/chat/completions",
                headers={
                    'Authorization': f'Bearer {consumer_token}',
                    'Content-Type': 'application/json',
                },
                json=request_body,
                timeout=120,
            )

            if not response.ok:
                raise Exception(f"Gateway error: {response.status_code} {response.text}")

            result = response.json()

            return {
                'content': result.get('choices', [{}])[0].get('message', {}).get('content', ''),
                'usage': result.get('usage', {}),
            }

        except requests.exceptions.Timeout:
            raise Exception("LLM request timeout via gateway")
        except requests.exceptions.RequestException as e:
            raise Exception(f"Gateway request failed: {str(e)}")

class MiniMaxAgent(HermesAgent):
    """
    Hermes agent with MiniMax API integration.
    Supports custom base URL for MiniMax/other OpenAI-compatible APIs.
    
    Gateway Mode: When GATEWAY_ENABLED=true, routes calls through the
    Turing OS gateway proxy using consumer tokens instead of direct API.
    
    Usage:
        agent = MiniMaxAgent(ticket_id="123", api_key="your-api-key")
        agent.run()
    """
    
    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Call MiniMax via the orchestrator gateway (mandatory)."""
        if not os.environ.get('GATEWAY_URL') or not os.environ.get('CONSUMER_TOKEN'):
            raise RuntimeError(
                'LLM gateway is not configured (GATEWAY_URL + CONSUMER_TOKEN). '
                'Workers must be spawned with gateway mode.'
            )
        return self._call_llm_via_gateway(messages)

    def _call_llm_direct(self, messages: list[AgentMessage] = None) -> dict:
        """Call MiniMax API directly"""
        from openai import OpenAI
        
        # MiniMax uses OpenAI-compatible API
        client = OpenAI(api_key=self.api_key, base_url="https://api.minimax.io/v1")
        
        # Convert messages to OpenAI format
        # NOTE: MiniMax API doesn't support system role, so we prepend to first user message
        system_content = ""
        openai_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'system':
                system_content = msg.content
            elif msg.role == 'user':
                if system_content:
                    openai_messages.append({"role": "user", "content": system_content + "\n\n" + msg.content})
                    system_content = ""
                else:
                    openai_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                openai_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                openai_messages.append({"role": "user", "content": msg.content})
        
        response = client.chat.completions.create(
            model=self.model,
            messages=openai_messages,
            temperature=0.3,
            max_tokens=4096,
        )
        
        return {
            'content': response.choices[0].message.content,
            'usage': {
                'prompt_tokens': response.usage.prompt_tokens,
                'completion_tokens': response.usage.completion_tokens,
                'total_tokens': response.usage.total_tokens,
            }
        }

    def _call_llm_via_gateway(self, messages: list[AgentMessage] = None) -> dict:
        """Call LLM via Turing OS Gateway Proxy"""
        gateway_url = os.environ.get('GATEWAY_URL')
        consumer_token = os.environ.get('CONSUMER_TOKEN')

        # Convert messages to OpenAI format
        system_content = ""
        openai_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'system':
                system_content = msg.content
            elif msg.role == 'user':
                if system_content:
                    openai_messages.append({"role": "user", "content": system_content + "\n\n" + msg.content})
                    system_content = ""
                else:
                    openai_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                openai_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                openai_messages.append({"role": "user", "content": msg.content})

        # Build request for gateway
        request_body = {
            'model': self.model,
            'messages': openai_messages,
            'temperature': 0.3,
            'max_tokens': 4096,
        }

        try:
            response = requests.post(
                f"{gateway_url}/gateway/llm/chat/completions",
                headers={
                    'Authorization': f'Bearer {consumer_token}',
                    'Content-Type': 'application/json',
                },
                json=request_body,
                timeout=120,
            )

            if not response.ok:
                raise Exception(f"Gateway error: {response.status_code} {response.text}")

            result = response.json()

            return {
                'content': result.get('choices', [{}])[0].get('message', {}).get('content', ''),
                'usage': result.get('usage', {}),
            }

        except requests.exceptions.Timeout:
            raise Exception("LLM request timeout via gateway")
        except requests.exceptions.RequestException as e:
            raise Exception(f"Gateway request failed: {str(e)}")

class AnthropicAgent(HermesAgent):
    """
    Hermes agent with Anthropic Claude integration.
    Supports configurable model.
    
    Gateway Mode: When GATEWAY_ENABLED=true, routes calls through the
    Turing OS gateway proxy using consumer tokens instead of direct API.
    Note: Gateway must have an Anthropic-compatible endpoint configured.
    """

    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Call Anthropic via the orchestrator gateway (mandatory)."""
        if not os.environ.get('GATEWAY_URL') or not os.environ.get('CONSUMER_TOKEN'):
            raise RuntimeError(
                'LLM gateway is not configured (GATEWAY_URL + CONSUMER_TOKEN). '
                'Workers must be spawned with gateway mode.'
            )
        return self._call_llm_via_gateway(messages)

    def _call_llm_direct(self, messages: list[AgentMessage] = None) -> dict:
        """Call Anthropic Claude API directly. Legacy mode — gateway is the supported path."""
        import anthropic

        if not getattr(self, "_warned_legacy_llm", False):
            print("[Hermes] WARNING: using legacy direct LLM mode. Set GATEWAY_ENABLED=true to route through the orchestrator gateway.")
            self._warned_legacy_llm = True
        if not self.api_key:
            raise RuntimeError("LLM_API_KEY not set and gateway mode is disabled — worker cannot reach the LLM")
        client = anthropic.Anthropic(api_key=self.api_key)

        # Extract system message
        system_content = ''
        claude_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'system':
                system_content = msg.content
            elif msg.role == 'user':
                claude_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                claude_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                claude_messages.append({"role": "user", "content": msg.content})

        # Ensure messages alternate user/assistant
        deduped = []
        last_role = None
        for msg in claude_messages:
            if msg['role'] == last_role:
                # Merge consecutive same-role messages
                deduped[-1]['content'] += '\n\n' + msg['content']
            else:
                deduped.append(msg)
                last_role = msg['role']

        # Ensure first message is from user
        if deduped and deduped[0]['role'] != 'user':
            deduped.insert(0, {"role": "user", "content": "Please proceed with the task."})

        kwargs = {
            'model': self.model if 'claude' in self.model else 'claude-sonnet-4-20250514',
            'max_tokens': 4096,
            'messages': deduped,
        }
        if system_content:
            kwargs['system'] = system_content

        response = client.messages.create(**kwargs)

        return {
            'content': response.content[0].text,
            'usage': {
                'input_tokens': response.usage.input_tokens,
                'output_tokens': response.usage.output_tokens,
            }
        }

    def _call_llm_via_gateway(self, messages: list[AgentMessage] = None) -> dict:
        """Call LLM via Turing OS Gateway Proxy (OpenAI-compatible format)"""
        gateway_url = os.environ.get('GATEWAY_URL')
        consumer_token = os.environ.get('CONSUMER_TOKEN')

        # For Anthropic, we convert to OpenAI format for the gateway
        system_content = ""
        openai_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'system':
                system_content = msg.content
            elif msg.role == 'user':
                openai_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                openai_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                openai_messages.append({"role": "user", "content": msg.content})

        # If we have system content, prepend to first user message
        if system_content and openai_messages:
            first_msg = openai_messages[0]
            if first_msg["role"] == "user":
                first_msg["content"] = f"[System: {system_content}]\n\n{first_msg['content']}"

        # Build request for gateway
        request_body = {
            'model': self.model if 'claude' in self.model else 'claude-sonnet-4-20250514',
            'messages': openai_messages,
            'temperature': 0.3,
            'max_tokens': 4096,
        }

        try:
            response = requests.post(
                f"{gateway_url}/gateway/llm/chat/completions",
                headers={
                    'Authorization': f'Bearer {consumer_token}',
                    'Content-Type': 'application/json',
                },
                json=request_body,
                timeout=120,
            )

            if not response.ok:
                raise Exception(f"Gateway error: {response.status_code} {response.text}")

            result = response.json()

            return {
                'content': result.get('choices', [{}])[0].get('message', {}).get('content', ''),
                'usage': result.get('usage', {}),
            }

        except requests.exceptions.Timeout:
            raise Exception("LLM request timeout via gateway")
        except requests.exceptions.RequestException as e:
            raise Exception(f"Gateway request failed: {str(e)}")