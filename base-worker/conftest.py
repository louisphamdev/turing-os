"""Pytest bootstrap: make `src` importable when tests run from base-worker/.

Linux/Windows pytest discovery differs for namespace packages without an
__init__.py. CI on Linux fails to resolve `from src.tools.X import Y` from
deeper modules unless the working directory is explicitly on sys.path.
"""

import os
import sys

_here = os.path.abspath(os.path.dirname(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
