"""
Research Tools - Local Methodology Skill Loader and Context7 Integration

Skill loading reads the Turing-flavored superpowers methodology skills from
the LOCAL `base-worker/skills/<name>.md` corpus (no network). The old remote
HTTP skill endpoint has been removed — it was dead and its failures were
silently swallowed.

Context7 research (research_with_context7) is unrelated to skills loading and
is kept intact for technology/library doc lookups.

Provides both async and sync wrappers so the synchronous Hermes agent loop can
call them.
"""

import os
import asyncio
from pathlib import Path
from typing import Optional

# Environment variables (injected at spawn time)
CONTEXT7_API_KEY = os.environ.get('CONTEXT7_API_KEY', '')

# Optional override for the local skills corpus location. When unset the loader
# probes a set of candidate dirs robust to both the dev checkout layout
# (base-worker/skills) and the container runtime layout (/workspace/src → so
# skills may live at /workspace/skills or /workspace/src/skills).
SKILLS_DIR_ENV = 'WORKER_SKILLS_DIR'


def _get_or_create_event_loop():
    """Get existing event loop or create a new one for sync wrappers"""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


def _candidate_skill_dirs() -> list[Path]:
    """Candidate locations for the local methodology skills corpus.

    Ordered by preference. Robust to:
      - explicit override via WORKER_SKILLS_DIR
      - dev checkout: base-worker/src/tools/research_tools.py → base-worker/skills
      - container: /workspace/src/tools/research_tools.py → /workspace/skills
        or /workspace/src/skills (depending on how skills/ is COPY'd into the image)
      - cwd-relative ./skills as a last resort
    """
    here = Path(__file__).resolve()
    candidates: list[Path] = []

    override = os.environ.get(SKILLS_DIR_ENV)
    if override:
        candidates.append(Path(override))

    # base-worker/skills (two parents up from src/tools/)
    candidates.append(here.parents[2] / 'skills')
    # /workspace/src/skills (one parent up from src/tools/ → src/skills)
    candidates.append(here.parents[1] / 'skills')
    # cwd-relative fallback
    candidates.append(Path.cwd() / 'skills')

    # De-dup preserving order.
    seen: set[str] = set()
    unique: list[Path] = []
    for c in candidates:
        key = str(c)
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique


def resolve_skills_dir() -> Optional[Path]:
    """Return the first existing candidate skills dir, or None if none exist."""
    for d in _candidate_skill_dirs():
        if d.is_dir():
            return d
    return None


def load_skill_file(skill_name: str) -> Optional[str]:
    """Read a single skill's markdown body from the local corpus.

    Returns the file contents (str) or None if the skill file is missing /
    unreadable. Never raises — a missing skill must NOT crash the worker.
    """
    name = skill_name.strip()
    if not name:
        return None
    # Allow callers to pass either "writing-plans" or "writing-plans.md".
    if name.endswith('.md'):
        name = name[:-3]

    for d in _candidate_skill_dirs():
        path = d / f"{name}.md"
        try:
            if path.is_file():
                return path.read_text(encoding='utf-8')
        except Exception as e:  # pragma: no cover - defensive
            print(f"[SkillsLoader] ✗ Error reading {path}: {e}")
    print(f"[SkillsLoader] ✗ Skill not found in local corpus: {name}.md")
    return None


def load_skills(skill_names: list[str]) -> dict[str, Optional[str]]:
    """Load multiple skill bodies from the local corpus.

    Returns a dict {skill_name: body_or_None}. Missing skills map to None and
    are logged but never raise.
    """
    results: dict[str, Optional[str]] = {}
    for skill in skill_names:
        name = skill.strip()
        if not name:
            continue
        body = load_skill_file(name)
        if body is not None:
            print(f"[SkillsLoader] ✓ Loaded local skill: {name}")
        results[name] = body
    return results


class Context7Client:
    """Context7 API client for technology research."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or CONTEXT7_API_KEY
        self.base_url = "https://api.context7.io/v1"
        self.timeout = 60
        self._cache: dict[str, str] = {}

    def _get_headers(self) -> dict:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def resolve_library_id(self, library_name: str) -> Optional[str]:
        """Resolve a library name to Context7 library ID."""
        if not self.api_key:
            print("[Context7] No API key configured")
            return None

        print(f"[Context7] Resolving library: {library_name}")

        try:
            import httpx
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(
                    f"{self.base_url}/library/resolve",
                    params={"name": library_name},
                    headers=self._get_headers(),
                )

                if response.status_code == 200:
                    data = response.json()
                    library_id = data.get("id") or data.get("library_id")
                    print(f"[Context7] Resolved: {library_id}")
                    return library_id
                else:
                    print(f"[Context7] Resolve failed: HTTP {response.status_code}")
                    return None
        except Exception as e:
            print(f"[Context7] Resolve error: {e}")
            return None

    async def get_library_docs(
        self,
        library_id: str,
        topic: Optional[str] = None,
        max_tokens: int = 10000,
    ) -> str:
        """Get documentation for a library."""
        if not self.api_key:
            return ""

        cache_key = f"{library_id}:{topic or 'general'}"
        if cache_key in self._cache:
            print(f"[Context7] Using cached docs for {cache_key}")
            return self._cache[cache_key]

        print(f"[Context7] Fetching docs: {library_id} (topic: {topic})")

        try:
            import httpx
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                params: dict = {"tokens": max_tokens}
                if topic:
                    params["topic"] = topic

                response = await client.get(
                    f"{self.base_url}/library/{library_id}/docs",
                    params=params,
                    headers=self._get_headers(),
                )

                if response.status_code == 200:
                    data = response.json()
                    docs = data.get("content", "") or data.get("docs", "")
                    self._cache[cache_key] = docs
                    print(f"[Context7] ✓ Retrieved {len(docs)} chars")
                    return docs
                else:
                    print(f"[Context7] Docs fetch failed: HTTP {response.status_code}")
                    return ""
        except Exception as e:
            print(f"[Context7] Docs fetch error: {e}")
            return ""

    async def research_technology(self, technology: str, topic: Optional[str] = None) -> str:
        """Convenience: Resolve library and get docs in one call."""
        library_id = await self.resolve_library_id(technology)
        if library_id:
            return await self.get_library_docs(library_id, topic=topic)
        return ""


# Global instances
context7_client: Optional[Context7Client] = None


def init_research_tools(context7_api_key: Optional[str] = None):
    """Initialize research tools with API keys."""
    global context7_client

    api_key = context7_api_key or CONTEXT7_API_KEY
    context7_client = Context7Client(api_key=api_key)

    skills_dir = resolve_skills_dir()
    print(
        f"[ResearchTools] Initialized — Context7: {'✓' if api_key else '✗ (no key)'}, "
        f"skills corpus: {skills_dir if skills_dir else '✗ (not found)'}"
    )


# =============================================================================
# SYNC Wrappers for Hermes Agent (which runs synchronously)
# =============================================================================

def load_skills_for_task_sync(skill_names: str) -> dict:
    """
    Load methodology skills from the LOCAL corpus before task execution. (Sync)

    Args:
        skill_names: Comma-separated list of skill names
            (e.g., "test-driven-development,systematic-debugging").
            The ".md" suffix is optional.

    Returns:
        Summary of loaded skills, including the skill bodies under "details".
    """
    skills = [s.strip() for s in skill_names.split(",") if s.strip()]
    results = load_skills(skills)

    success_count = sum(1 for v in results.values() if v)
    return {
        "success": True,
        "loaded": success_count,
        "total": len(skills),
        "details": {
            name: (body if body is not None else {"error": "skill not found"})
            for name, body in results.items()
        },
    }


def research_with_context7_sync(library_name: str, topic: Optional[str] = None) -> str:
    """
    Research a technology using Context7 API. (Sync wrapper)

    Args:
        library_name: Name of library to research (e.g., "fastapi", "react")
        topic: Optional specific topic (e.g., "authentication", "hooks")

    Returns:
        Documentation/research content
    """
    if not context7_client:
        init_research_tools()

    try:
        loop = _get_or_create_event_loop()
        docs = loop.run_until_complete(
            context7_client.research_technology(library_name, topic=topic)
        )
    except Exception as e:
        print(f"[ResearchTools] Context7 research failed: {e}")
        docs = ""

    return docs if docs else "No documentation found"


def get_research_capabilities() -> dict:
    """
    Check available research capabilities and skills-corpus status.
    """
    skills_dir = resolve_skills_dir()
    return {
        "skills_corpus_available": skills_dir is not None,
        "skills_corpus_dir": str(skills_dir) if skills_dir else None,
        "context7_available": context7_client is not None and bool(context7_client.api_key),
        "context7_api_key_set": bool(CONTEXT7_API_KEY),
    }


# Keep async versions available for future use
async def load_skills_for_task(skill_names: str) -> dict:
    """Async version of load_skills_for_task_sync (local corpus, no network)."""
    return load_skills_for_task_sync(skill_names)


async def research_with_context7(library_name: str, topic: Optional[str] = None) -> str:
    """Async version of research_with_context7_sync"""
    if not context7_client:
        init_research_tools()
    docs = await context7_client.research_technology(library_name, topic=topic)
    return docs if docs else "No documentation found"
