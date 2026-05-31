"""Unit tests for the safe dynamic-import allow-list (Task P2-7)."""

import pytest

from src.tools._safe_import import (
    ALLOWED_TOOL_MODULE_PREFIXES,
    DisallowedModuleError,
    is_allowed_module,
    safe_import_module,
)


# ─── Predicate: allowed module paths ────────────────────────────────────────

@pytest.mark.parametrize(
    "module_path",
    [
        "tools",
        "src.tools",
        "tools.local_exec",
        "src.tools.local_exec",
        "tools.research_tools",
        "src.tools.tool_registry",
    ],
)
def test_is_allowed_accepts_tools_package(module_path):
    assert is_allowed_module(module_path) is True


# ─── Predicate: rejected module paths ───────────────────────────────────────

@pytest.mark.parametrize(
    "module_path",
    [
        "os",
        "subprocess",
        "builtins",
        "sys",
        "antigravity",
        "some_random_module",
        # prefix look-alikes that must NOT match on a dot boundary
        "tools_evil",
        "toolsX",
        "src.toolsX",
        "evil.tools",
        "evil.src.tools",
        # dotted-escape / traversal / malformed
        "tools..os",
        ".tools",
        "tools.",
        "tools.../os",
        "tools .local_exec",
        "../tools/local_exec",
        "tools/local_exec",
        # non-str / empty
        "",
    ],
)
def test_is_allowed_rejects_everything_else(module_path):
    assert is_allowed_module(module_path) is False


@pytest.mark.parametrize("bad", [None, 123, [], {}, object()])
def test_is_allowed_rejects_non_str(bad):
    assert is_allowed_module(bad) is False


# ─── safe_import_module: real import + rejection ────────────────────────────

def test_safe_import_loads_allowed_module():
    """An allowed, real tools.* module imports and returns the module object."""
    module = safe_import_module("src.tools.local_exec")
    assert module is not None
    assert module.__name__.endswith("tools.local_exec")


@pytest.mark.parametrize(
    "module_path", ["os", "subprocess", "builtins", "totally_made_up_module"]
)
def test_safe_import_rejects_disallowed_module(module_path):
    """Disallowed modules raise DisallowedModuleError and are NOT imported."""
    with pytest.raises(DisallowedModuleError):
        safe_import_module(module_path)


def test_safe_import_rejection_is_an_import_error():
    """DisallowedModuleError is an ImportError subclass so existing
    `except ImportError` handlers still catch it."""
    assert issubclass(DisallowedModuleError, ImportError)


def test_allowed_prefixes_constant_is_the_single_source():
    """The allow-list lives in one extendable constant."""
    assert "tools" in ALLOWED_TOOL_MODULE_PREFIXES
    assert "src.tools" in ALLOWED_TOOL_MODULE_PREFIXES
