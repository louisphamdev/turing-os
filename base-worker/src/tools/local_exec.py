"""
Local Execution Tool
Executes shell commands and file operations inside the container sandbox.
STRICT RULE #1: Zero-State Worker - all execution is ephemeral.
"""

import subprocess
import os
from typing import Optional

# Commands that should never be executed
BLOCKED_COMMANDS = [
    'rm -rf /',
    'dd if=',
    'mkfs',
    ':(){:|:&};:',
    'chmod -R 777 /',
    '> /dev/sda',
]

MAX_OUTPUT_LENGTH = 10000  # characters


def execute_terminal_command(command: str, working_dir: str = "/workspace") -> str:
    """
    Executes a shell command inside the container sandbox.
    Returns stdout on success, stderr on failure.
    Timeout: 120 seconds. Output truncated to 10000 chars.

    Args:
        command: Shell command to execute
        working_dir: Working directory (default: /workspace)
    """
    print(f"[LocalExec] Executing: {command}")

    # Security: block dangerous commands
    cmd_lower = command.lower().strip()
    for blocked in BLOCKED_COMMANDS:
        if blocked in cmd_lower:
            return f"Error: Command blocked for safety: {blocked}"

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=working_dir if os.path.isdir(working_dir) else None,
        )

        if result.returncode == 0:
            output = result.stdout
        else:
            output = f"Exit code: {result.returncode}\n"
            if result.stderr:
                output += f"STDERR:\n{result.stderr}\n"
            if result.stdout:
                output += f"STDOUT:\n{result.stdout}"

        # Truncate long output
        if len(output) > MAX_OUTPUT_LENGTH:
            output = output[:MAX_OUTPUT_LENGTH] + f"\n... [truncated, total: {len(output)} chars]"

        print(f"[LocalExec] Exit: {result.returncode}, Output: {output[:300]}")
        return output

    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 120 seconds"
    except Exception as e:
        return f"Error: {str(e)}"


def read_file(file_path: str) -> str:
    """
    Read the contents of a file from the workspace.
    Returns file content as string, or error message.

    Args:
        file_path: Path to the file (relative to /workspace or absolute)
    """
    # Resolve relative paths
    if not os.path.isabs(file_path):
        file_path = os.path.join('/workspace', file_path)

    print(f"[LocalExec] Reading file: {file_path}")

    try:
        if not os.path.exists(file_path):
            return f"Error: File not found: {file_path}"

        if os.path.getsize(file_path) > 500_000:  # 500KB limit
            return f"Error: File too large ({os.path.getsize(file_path)} bytes). Max 500KB."

        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()

        if len(content) > MAX_OUTPUT_LENGTH:
            content = content[:MAX_OUTPUT_LENGTH] + f"\n... [truncated, total: {len(content)} chars]"

        return content

    except Exception as e:
        return f"Error reading file: {str(e)}"


def write_file(file_path: str, content: str) -> str:
    """
    Write content to a file in the workspace.
    Creates parent directories if they don't exist.

    Args:
        file_path: Path to the file (relative to /workspace or absolute)
        content: Content to write
    """
    if not os.path.isabs(file_path):
        file_path = os.path.join('/workspace', file_path)

    print(f"[LocalExec] Writing file: {file_path} ({len(content)} chars)")

    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)

        return f"Successfully wrote {len(content)} chars to {file_path}"

    except Exception as e:
        return f"Error writing file: {str(e)}"


def verify_python_syntax(code: str) -> str:
    """
    Verify Python code syntax without executing.
    Returns 'OK' or the syntax error message.

    Args:
        code: Python code to verify
    """
    try:
        compile(code, '<string>', 'exec')
        return "OK: Syntax is valid"
    except SyntaxError as e:
        return f"Syntax Error: {e.msg} (line {e.lineno})"


def run_tests(test_command: str = "pytest") -> str:
    """
    Run pytest or other test commands.
    Returns test output.

    Args:
        test_command: Test command to run (default: pytest)
    """
    return execute_terminal_command(test_command)