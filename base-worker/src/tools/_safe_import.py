"""
Safe dynamic-import helper — allow-list for caller-supplied module paths.

SECURITY (Task P2-7): The worker runs with CONSUMER_TOKEN in its process.
Several code paths import Python modules from *caller-supplied* strings:
  - admin/structured-command args (`tool_module`) in command_executor.py
  - JSON read from a BookStack `/tools/*` page (`module`) in tool_registry.py

`importlib.import_module(<attacker string>)` executes the target module's
top-level code in this process. Importing `os`, `subprocess`, `builtins`, or
a hostile third-party/wiki-injected module is therefore arbitrary code
execution. This module gates every such import through an allow-list so only
the worker's own tool package can be loaded dynamically.

Allow rule
----------
Only modules under the worker's own `tools` package are permitted. At runtime
the worker starts as `python /workspace/src/index.py`, so `/workspace/src` is
`sys.path[0]` and the package is importable as `tools.X`. Under pytest/CI the
working dir is `base-worker/` (with `src` on the path via conftest), so the
same package is `src.tools.X`. Both prefixes therefore name the *same* files
and are allowed; everything else is rejected.

Dotted-escape / traversal tricks (`tools.../os`, leading/trailing dots,
`tools .x`, absolute or relative path fragments) fail the segment validation
below and are rejected.
"""

import importlib

# Keep the rule in ONE place so it is easy to audit and extend.
# A module path is allowed iff it is exactly one of these, or starts with one
# of these followed by a dot (i.e. is a submodule of the tools package).
ALLOWED_TOOL_MODULE_PREFIXES = ("tools", "src.tools")


class DisallowedModuleError(ImportError):
    """Raised when a caller-supplied module path is not on the allow-list."""


def is_allowed_module(module_path: str) -> bool:
    """
    Return True iff ``module_path`` resolves under the worker's tools package.

    The check is purely syntactic (no import happens here) and is strict:
      - the value must be a non-empty str of dot-separated identifiers
        (rejects empty/None, leading/trailing/double dots, whitespace, slashes,
        path traversal, and other non-identifier segments), and
      - its first segment(s) must match an allowed prefix exactly, on a
        dot boundary (so ``tools.local_exec`` is allowed but ``tools_evil``
        and ``toolsX`` are not).
    """
    if not module_path or not isinstance(module_path, str):
        return False

    segments = module_path.split(".")
    # Every segment must be a valid Python identifier. This rejects "", which
    # appears for leading/trailing/double dots, as well as whitespace, slashes,
    # and other path/traversal characters.
    if not all(seg.isidentifier() for seg in segments):
        return False

    for prefix in ALLOWED_TOOL_MODULE_PREFIXES:
        prefix_segs = prefix.split(".")
        if segments[: len(prefix_segs)] == prefix_segs:
            return True

    return False


def safe_import_module(module_path: str):
    """
    Import ``module_path`` only if it is on the tools-package allow-list.

    Returns the imported module. Raises ``DisallowedModuleError`` if the path
    is not allowed (callers must handle this and surface a clear error rather
    than silently swallowing it). Allowed-but-missing modules raise the usual
    ``ImportError`` from importlib.
    """
    if not is_allowed_module(module_path):
        raise DisallowedModuleError(
            f"Refusing to import disallowed module {module_path!r}: only "
            f"modules under {ALLOWED_TOOL_MODULE_PREFIXES} may be loaded "
            f"dynamically."
        )
    return importlib.import_module(module_path)
