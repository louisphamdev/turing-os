"""
Research Tools - Skills.sh Loader and Context7 Integration

MANDATORY: Every worker MUST load relevant skills from skills.sh before starting task.
MANDATORY: Use context7 for technology research when unfamiliar frameworks/SDKs are encountered.

Provides both async and sync wrappers so the synchronous Hermes agent loop can call them.
"""

import os
import json
import asyncio
from typing import Optional, Any

# Environment variables (injected at spawn time)
CONTEXT7_API_KEY = os.environ.get('CONTEXT7_API_KEY', '')
SKILLS_SH_BASE_URL = "https://skills.sh"


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


class SkillsLoader:
    """Load skills from skills.sh before task execution."""

    def __init__(self):
        self.base_url = SKILLS_SH_BASE_URL
        self.timeout = 30
        self._cache: dict[str, Any] = {}

    async def load_skills(self, skill_names: list[str]) -> dict[str, Any]:
        """Load skill modules from skills.sh"""
        results = {}

        for skill in skill_names:
            if skill in self._cache:
                print(f"[SkillsLoader] Using cached skill: {skill}")
                results[skill] = self._cache[skill]
                continue

            print(f"[SkillsLoader] Fetching skill: {skill}")

            try:
                import httpx
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.get(
                        f"{self.base_url}/api/skills/{skill}",
                        headers={"Accept": "application/json"},
                    )

                    if response.status_code == 200:
                        skill_data = response.json()
                        self._cache[skill] = skill_data
                        results[skill] = skill_data
                        print(f"[SkillsLoader] ✓ Loaded skill: {skill}")
                    else:
                        print(f"[SkillsLoader] ✗ Failed: {skill} (HTTP {response.status_code})")
                        results[skill] = {"error": f"HTTP {response.status_code}", "skill": skill}

            except Exception as e:
                print(f"[SkillsLoader] ✗ Error loading {skill}: {e}")
                results[skill] = {"error": str(e), "skill": skill}

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
skills_loader: Optional[SkillsLoader] = None
context7_client: Optional[Context7Client] = None


def init_research_tools(context7_api_key: Optional[str] = None):
    """Initialize research tools with API keys."""
    global skills_loader, context7_client

    api_key = context7_api_key or CONTEXT7_API_KEY

    skills_loader = SkillsLoader()
    context7_client = Context7Client(api_key=api_key)

    print(f"[ResearchTools] Initialized — Context7: {'✓' if api_key else '✗ (no key)'}")


# =============================================================================
# SYNC Wrappers for Hermes Agent (which runs synchronously)
# =============================================================================

def load_skills_for_task_sync(skill_names: str) -> dict:
    """
    Load skills from skills.sh before task execution. (Sync wrapper)

    Args:
        skill_names: Comma-separated list of skill names (e.g., "python,fastapi,sql")

    Returns:
        Summary of loaded skills
    """
    if not skills_loader:
        init_research_tools()

    skills = [s.strip() for s in skill_names.split(",") if s.strip()]

    try:
        loop = _get_or_create_event_loop()
        results = loop.run_until_complete(skills_loader.load_skills(skills))
    except Exception as e:
        print(f"[ResearchTools] Skills loading failed: {e}")
        results = {s: {"error": str(e)} for s in skills}

    success_count = sum(1 for r in results.values() if "error" not in r)
    return {
        "success": True,
        "loaded": success_count,
        "total": len(skills),
        "details": results,
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
    Check available research capabilities and API key status.
    """
    return {
        "skills_sh_available": skills_loader is not None,
        "context7_available": context7_client is not None and bool(context7_client.api_key),
        "context7_api_key_set": bool(CONTEXT7_API_KEY),
    }


# Keep async versions available for future use
async def load_skills_for_task(skill_names: str) -> dict:
    """Async version of load_skills_for_task_sync"""
    if not skills_loader:
        init_research_tools()
    skills = [s.strip() for s in skill_names.split(",") if s.strip()]
    results = await skills_loader.load_skills(skills)
    success_count = sum(1 for r in results.values() if "error" not in r)
    return {"success": True, "loaded": success_count, "total": len(skills), "details": results}


async def research_with_context7(library_name: str, topic: Optional[str] = None) -> str:
    """Async version of research_with_context7_sync"""
    if not context7_client:
        init_research_tools()
    docs = await context7_client.research_technology(library_name, topic=topic)
    return docs if docs else "No documentation found"
