"""
Local Execution Tool
Executes shell commands and file operations inside the container sandbox.
STRICT RULE #1: Zero-State Worker - all execution is ephemeral.

Security model: the container itself is the sandbox (ephemeral, AutoRemove=true,
no docker.sock, no host filesystem). It is the ONLY real isolation/security
boundary (hardened further by Task P2-1's container least-privilege work).

Shell semantics (pipes, redirects) are intentional. Defence-in-depth applies
via:
  * the BLOCKED_PATTERNS denylist (a guardrail against accidents, NOT a
    security boundary — see the note on BLOCKED_PATTERNS below),
  * the workspace-root containment check (`_resolve_workspace_path`), which
    keeps both file ops AND command working directories inside /workspace, and
  * a sanitized child-process environment that strips live secrets
    (`_SENSITIVE_ENV_KEYS`) so a misbehaving/injected command cannot
    `env`/`printenv` them out of the worker.
"""

import os
import re
import subprocess
from pathlib import Path

WORKSPACE_ROOT = Path("/workspace").resolve()

# Environment variables that hold live secrets / credentials. These MUST be
# stripped from any child process spawned for an LLM-issued command, otherwise
# a prompt-injected or misbehaving command could `env`/`printenv` and exfiltrate
# them. Everything NOT in this list (PATH, HOME, LANG, ...) is kept so normal
# commands keep working. Extend this list as new secrets are introduced.
_SENSITIVE_ENV_KEYS = frozenset({
    "CONSUMER_TOKEN",
    "WORKER_INTERNAL_TOKEN",
    "PLANE_API_TOKEN",
    "LLM_API_KEY",
    "BOOKSTACK_TOKEN",
    "GITHUB_TOKEN",
    "MATRIX_BOT_TOKEN",
    "VAULT_MASTER_KEY",
    "JWT_SECRET",
    "ADMIN_API_TOKEN",
    "SYNAPSE_REGISTRATION_SECRET",
    "PLANE_SECRET_KEY",
})

# Defence-in-depth ONLY: substring/regex match against obviously destructive
# commands. This denylist is a GUARDRAIL AGAINST ACCIDENTS, NOT a security
# boundary — it is trivially bypassable and must not be relied on for isolation.
# The real isolation is the container (ephemeral, no host FS, no docker.sock,
# plus the P2-1 least-privilege hardening). Do NOT grow this list expecting it
# to "block attackers"; it only stops the worst foot-guns early.
BLOCKED_PATTERNS = [
    re.compile(r"\brm\s+-[rf]+\s*/(?:\s|$)"),
    re.compile(r"\brm\s+-[rf]+\s+/\*"),
    re.compile(r"\bdd\s+if="),
    re.compile(r"\bmkfs\b"),
    re.compile(r":\(\)\{:\|:&\};:"),
    re.compile(r"\bchmod\s+-R\s+777\s+/"),
    re.compile(r">\s*/dev/sd[a-z]"),
]

MAX_OUTPUT_LENGTH = 10000  # characters


def _resolve_workspace_path(file_path: str) -> Path:
    """Resolve a user-supplied path and guarantee it stays inside WORKSPACE_ROOT."""
    candidate = Path(file_path)
    if not candidate.is_absolute():
        candidate = WORKSPACE_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(WORKSPACE_ROOT)
    except ValueError as exc:
        raise PermissionError(f"Path escapes workspace: {file_path}") from exc
    return resolved


def _sanitized_env() -> dict:
    """Return a copy of os.environ with live secrets removed.

    Strips every key in `_SENSITIVE_ENV_KEYS` and keeps everything else
    (PATH, HOME, LANG, ...) so normal commands still work. Used for every
    subprocess spawned to run an LLM-issued command so the command cannot
    read the worker's credentials out of the environment.
    """
    return {k: v for k, v in os.environ.items() if k not in _SENSITIVE_ENV_KEYS}


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

    # Containment: keep the working directory inside the workspace root, the
    # same boundary enforced for read_file/write_file. An empty/None value
    # defaults to the workspace root. A path that resolves outside the
    # workspace (absolute escape or `..` traversal) is rejected, not executed.
    if not working_dir:
        working_dir = str(WORKSPACE_ROOT)
    try:
        resolved_cwd = _resolve_workspace_path(working_dir)
    except PermissionError as exc:
        return f"Error: {exc}"

    # Guardrail (NOT a security boundary): block obviously destructive commands.
    # The container is the real sandbox; this only stops the worst foot-guns.
    cmd_lower = command.lower().strip()
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(cmd_lower):
            return f"Error: Command blocked for safety (matched pattern: {pattern.pattern})"

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(resolved_cwd) if resolved_cwd.is_dir() else str(WORKSPACE_ROOT),
            env=_sanitized_env(),
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
    try:
        resolved = _resolve_workspace_path(file_path)
    except PermissionError as exc:
        return f"Error: {exc}"

    print(f"[LocalExec] Reading file: {resolved}")

    try:
        if not resolved.exists():
            return f"Error: File not found: {resolved}"

        size = resolved.stat().st_size
        if size > 500_000:  # 500KB limit
            return f"Error: File too large ({size} bytes). Max 500KB."

        content = resolved.read_text(encoding='utf-8', errors='replace')

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
    try:
        resolved = _resolve_workspace_path(file_path)
    except PermissionError as exc:
        return f"Error: {exc}"

    print(f"[LocalExec] Writing file: {resolved} ({len(content)} chars)")

    try:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding='utf-8')
        return f"Successfully wrote {len(content)} chars to {resolved}"

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