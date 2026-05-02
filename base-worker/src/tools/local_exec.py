"""
Local Execution Tool
Executes shell commands inside the container sandbox
STRICT RULE #1: Zero-State Worker - all execution is ephemeral
"""

import subprocess
from typing import Tuple

def execute_terminal_command(command: str) -> str:
    """
    Executes a shell command inside the container sandbox to verify 
    code syntax or run tests.
    
    Returns the standard output (stdout) or standard error (stderr).
    """
    print(f"[LocalExec] Executing: {command}")
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60
        )
        
        output = result.stdout if result.returncode == 0 else result.stderr
        print(f"[LocalExec] Output: {output[:500]}")
        return output
        
    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 60 seconds"
    except Exception as e:
        return f"Error: {str(e)}"


def verify_python_syntax(code: str) -> Tuple[bool, str]:
    """
    Verify Python code syntax without executing
    """
    result = execute_terminal_command(f"python -m py_compile << '{code}'")
    return (result == "", result)


def run_tests(test_command: str) -> str:
    """
    Run pytest or other test commands
    """
    return execute_terminal_command(test_command)