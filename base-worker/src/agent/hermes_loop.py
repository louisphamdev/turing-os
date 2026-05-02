"""
Hermes Agent - ReAct Loop with Tool Calling
The core reasoning engine that drives worker behavior.
"""

import os
import json
import re
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
    role: str  # 'user', 'assistant', 'tool'
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
        max_iterations: int = 10,
        tool_timeout: int = 60
    ):
        self.ticket_id = ticket_id
        self.role = role
        self.api_key = api_key or os.environ.get('LLM_API_KEY')
        self.max_iterations = max_iterations
        self.tool_timeout = tool_timeout
        
        self.tools: dict[str, Callable] = {}
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
        from tools import plane_tools, bookstack_tools, local_exec, research_tools
        
        self.register_tool('update_ticket_status', plane_tools.update_ticket_status)
        self.register_tool('read_ticket', plane_tools.read_ticket)
        self.register_tool('add_comment', plane_tools.add_comment)
        self.register_tool('execute_terminal_command', local_exec.execute_terminal_command)
        self.register_tool('read_document', bookstack_tools.read_document)
        self.register_tool('search_documents', bookstack_tools.search_documents)
        self.register_tool('list_documents', bookstack_tools.list_documents)
        
        # Research tools - MANDATORY for every task
        self.register_tool('load_skills_for_task', research_tools.load_skills_for_task)
        self.register_tool('research_with_context7', research_tools.research_with_context7)
        self.register_tool('get_research_capabilities', research_tools.get_research_capabilities)
        
        # Initialize research tools with API key from environment
        research_tools.init_research_tools()
        
    def register_tool(self, name: str, func: Callable):
        """Register a tool function"""
        self.tools[name] = func
        print(f"[Hermes] Registered tool: {name}")
        
    def register_tools(self, tools: dict[str, Callable]):
        """Register multiple tools at once"""
        for name, func in tools.items():
            self.register_tool(name, func)
            
    def run(self, initial_task: Optional[str] = None) -> str:
        """
        Main entry point to run the agent.
        Returns 'done', 'blocked', or 'max_iterations'
        """
        print(f"[Hermes] Starting agent for ticket {self.ticket_id}, role: {self.role}")
        
        # Set initial task in context
        if initial_task:
            self.context['task'] = initial_task
            
        # Build system prompt
        system_prompt = self._build_system_prompt()
        self._add_message('user', system_prompt)
        
        for iteration in range(self.max_iterations):
            self.context['iteration'] = iteration + 1
            print(f"[Hermes] Iteration {self.context['iteration']}/{self.max_iterations}")
            
            # Get LLM response
            response = self._call_llm()
            
            # Parse tool calls from response
            tool_calls = self._parse_tool_calls(response)
            
            if not tool_calls:
                # No tool calls - check for final answer or continue
                if 'final_answer' in response or 'done' in response:
                    print("[Hermes] Task appears complete, no more tool calls")
                    return 'done'
                continue
                
            # Execute tool calls and add to history
            for tool_call in tool_calls:
                result = self._execute_tool(tool_call)
                self._add_tool_result(tool_call, result)
                
            # Check if task is done
            if self._is_task_complete():
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

⚠️ BEFORE STARTING ANY TASK, you MUST load relevant skills from skills.sh:

```
TOOL_CALL: load_skills_for_task
ARGUMENTS: {{"skill_names": "python,fastapi,sql"}}
```

Replace "python,fastapi,sql" with the actual skills needed for your task:
- From language/*.md files (e.g., dotnet, java, react)
- From specialization/*.md files (e.g., backend, frontend)
- Any additional frameworks/SDKs mentioned in the task

⚠️ If you encounter unfamiliar frameworks or SDKs, use context7 to research:

```
TOOL_CALL: research_with_context7
ARGUMENTS: {{"library_name": "fastapi", "topic": "authentication"}}
```

## Task
{self.context.get('task', 'Complete the assigned task.')}

## Available Tools
You MUST use tools to interact with the external world. Available tools:

{tools_schema}

## Response Format
When you need to call a tool, respond with:
```
TOOL_CALL: tool_name
ARGUMENTS: {{"arg1": "value1", "arg2": "value2"}}
```

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
            doc = func.__doc__ or "No description"
            sig_lines = []
            import inspect
            sig = inspect.signature(func)
            for param_name, param in sig.parameters.items():
                if param_name in ('self', 'cls'):
                    continue
                default = "" if param.default == inspect.Parameter.empty else f" = {param.default}"
                sig_lines.append(f"  - {param_name}: {param.annotation.__name__ if hasattr(param.annotation, '__name__') else str(param.annotation)}{default}")
            
            schema_parts.append(f"### {name}\n{doc.strip()}\nParameters:\n{chr(10).join(sig_lines)}")
        
        return chr(10).join(schema_parts)
    
    def _add_message(self, role: str, content: str):
        """Add a message to history"""
        self.messages.append(AgentMessage(role=role, content=content))
        
    def _add_tool_result(self, tool_call: ToolCall, result: ToolResult):
        """Add a tool result to history"""
        # Find the last assistant message and add tool result
        for msg in reversed(self.messages):
            if msg.role == 'assistant' and tool_call in msg.tool_calls:
                msg.tool_results.append(result)
                break
        else:
            # Create new message if not found
            msg = AgentMessage(role='tool', content=f"Result of {tool_call.name}: {result.result}")
            msg.tool_results.append(result)
            self.messages.append(msg)
    
    def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
        """Execute a tool and return the result"""
        print(f"[Hermes] Calling tool: {tool_call.name} with args: {tool_call.arguments}")
        
        if tool_call.name not in self.tools:
            return ToolResult(success=False, result=None, error=f"Unknown tool: {tool_call.name}")
            
        try:
            func = self.tools[tool_call.name]
            result = func(**tool_call.arguments)
            return ToolResult(success=True, result=result)
        except Exception as e:
            print(f"[Hermes] Tool error: {e}")
            return ToolResult(success=False, result=None, error=str(e))
    
    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """
        Call the LLM API.
        Override this method to use different LLM providers.
        Default: OpenAI GPT-4 compatible
        """
        # This is a placeholder - implement actual LLM call
        raise NotImplementedError("Override _call_llm() with your LLM provider")
    
    def _parse_tool_calls(self, response: dict) -> list[ToolCall]:
        """Parse tool calls from LLM response"""
        tool_calls = []
        
        content = response.get('content', '') or response.get('text', '')
        
        # Parse text format: TOOL_CALL: tool_name ARGUMENTS: {...}
        tool_pattern = r'TOOL_CALL:\s*(\w+)\s*ARGUMENTS:\s*(\{.*?\})'
        matches = re.finditer(tool_pattern, content, re.DOTALL)
        
        for match in matches:
            name = match.group(1)
            args_str = match.group(2)
            try:
                args = json.loads(args_str)
                tool_calls.append(ToolCall(name=name, arguments=args))
            except json.JSONDecodeError as e:
                print(f"[Hermes] Failed to parse arguments: {e}")
                
        # Also check structured format
        if 'tool_calls' in response:
            for tc in response['tool_calls']:
                if isinstance(tc, dict):
                    tool_calls.append(ToolCall(
                        name=tc.get('name', tc.get('function', {}).get('name', '')),
                        arguments=tc.get('arguments', tc.get('args', tc.get('function', {}).get('arguments', {})))
                    ))
                    
        return tool_calls
    
    def _is_task_complete(self) -> bool:
        """Check if the task is complete by looking at recent tool calls"""
        for msg in reversed(self.messages):
            if msg.role == 'tool':
                for result in msg.tool_results:
                    if hasattr(result.result, '__iter__') and 'status' in str(result.result):
                        if any(s in str(result.result).upper() for s in ['DONE', 'REVIEW', 'BLOCKED']):
                            return True
        return False
    
    def get_history(self) -> list[AgentMessage]:
        """Get the conversation history"""
        return self.messages.copy()


class OpenAIAgent(HermesAgent):
    """
    Hermes agent with OpenAI GPT-4 integration.
    Usage:
        agent = OpenAIAgent(ticket_id="123", api_key="sk-...")
        agent.run()
    """
    
    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Call OpenAI API"""
        import openai
        
        # Convert messages to OpenAI format
        openai_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'user':
                openai_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                openai_messages.append({"role": "assistant", "content": msg.content})
            elif msg.role == 'tool':
                for result in msg.tool_results:
                    openai_messages.append({
                        "role": "tool", 
                        "content": str(result.result)
                    })
        
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=openai_messages,
            temperature=0.7,
            max_tokens=2000
        )
        
        return {
            'content': response.choices[0].message.content,
            'usage': response.usage.to_dict()
        }


class AnthropicAgent(HermesAgent):
    """
    Hermes agent with Anthropic Claude integration.
    Usage:
        agent = AnthropicAgent(ticket_id="123", api_key="sk-ant-...")
        agent.run()
    """
    
    def _call_llm(self, messages: list[AgentMessage] = None) -> dict:
        """Call Anthropic Claude API"""
        import anthropic
        
        client = anthropic.Anthropic(api_key=self.api_key)
        
        # Convert messages to Claude format
        claude_messages = []
        for msg in (messages or self.messages):
            if msg.role == 'user':
                claude_messages.append({"role": "user", "content": msg.content})
            elif msg.role == 'assistant':
                claude_messages.append({"role": "assistant", "content": msg.content})
                
        response = client.messages.create(
            model="claude-3-opus-20240229",
            max_tokens=2000,
            messages=claude_messages
        )
        
        return {
            'content': response.content[0].text,
            'usage': {
                'input_tokens': response.usage.input_tokens,
                'output_tokens': response.usage.output_tokens
            }
        }