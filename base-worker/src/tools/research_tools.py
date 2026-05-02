"""
Research Tools - Skills.sh Loader and Context7 Integration

MANDATORY: Every worker MUST load relevant skills from skills.sh before starting task.
MANDATORY: Use context7 for technology research when unfamiliar frameworks/SDKs are encountered.

API Keys are injected at container spawn time from BookStack secret storage.
"""

import os
import json
import httpx
from typing import Optional, Any

# Environment variables (injected at spawn time)
CONTEXT7_API_KEY = os.environ.get('CONTEXT7_API_KEY', '')
SKILLS_SH_BASE_URL = "https://skills.sh"


class SkillsLoader:
    """
    Load skills from skills.sh before task execution.
    
    Usage:
        loader = SkillsLoader()
        skills = await loader.load_skills(["python", "fastapi", "sql"])
    """
    
    def __init__(self):
        self.base_url = SKILLS_SH_BASE_URL
        self.timeout = 30
        self._cache: dict[str, Any] = {}
    
    async def load_skills(self, skill_names: list[str]) -> dict[str, Any]:
        """
        Load skill modules from skills.sh for the given skill names.
        
        Args:
            skill_names: List of skill identifiers (e.g., ["python", "fastapi", "react"])
            
        Returns:
            Dictionary mapping skill names to their loaded content/config
        """
        results = {}
        
        for skill in skill_names:
            if skill in self._cache:
                print(f"[SkillsLoader] Using cached skill: {skill}")
                results[skill] = self._cache[skill]
                continue
                
            print(f"[SkillsLoader] Fetching skill from skills.sh: {skill}")
            
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    # skills.sh API pattern
                    response = await client.get(
                        f"{self.base_url}/api/skills/{skill}",
                        headers={"Accept": "application/json"}
                    )
                    
                    if response.status_code == 200:
                        skill_data = response.json()
                        self._cache[skill] = skill_data
                        results[skill] = skill_data
                        print(f"[SkillsLoader] ✓ Loaded skill: {skill}")
                    else:
                        print(f"[SkillsLoader] ✗ Failed to load {skill}: HTTP {response.status_code}")
                        results[skill] = {"error": f"HTTP {response.status_code}", "skill": skill}
                        
            except httpx.TimeoutException:
                print(f"[SkillsLoader] ✗ Timeout loading {skill}")
                results[skill] = {"error": "timeout", "skill": skill}
            except Exception as e:
                print(f"[SkillsLoader] ✗ Error loading {skill}: {e}")
                results[skill] = {"error": str(e), "skill": skill}
        
        return results
    
    async def search_skills(self, query: str) -> list[dict]:
        """
        Search for relevant skills on skills.sh based on a query.
        
        Args:
            query: Search query (e.g., "python api testing")
            
        Returns:
            List of matching skill definitions
        """
        print(f"[SkillsLoader] Searching skills.sh for: {query}")
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(
                    f"{self.base_url}/api/search",
                    params={"q": query},
                    headers={"Accept": "application/json"}
                )
                
                if response.status_code == 200:
                    return response.json().get("results", [])
                else:
                    print(f"[SkillsLoader] Search failed: HTTP {response.status_code}")
                    return []
                    
        except Exception as e:
            print(f"[SkillsLoader] Search error: {e}")
            return []


class Context7Client:
    """
    Context7 API client for technology research.
    
    MANDATORY: When encountering unfamiliar frameworks/SDKs, use this to research
    best practices, API patterns, and proper usage.
    
    Usage:
        client = Context7Client()
        docs = await client.get_library_docs("mongodb/mongodb-driver-java")
    """
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or CONTEXT7_API_KEY
        self.base_url = "https://api.context7.io/v1"
        self.timeout = 60
        
    def _get_headers(self) -> dict:
        """Build request headers with API key"""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers
    
    async def resolve_library_id(self, library_name: str) -> Optional[str]:
        """
        Resolve a library/package name to Context7 library ID.
        
        Args:
            library_name: e.g., "mongodb", "react", "fastapi", "/mongodb/mongodb-java-driver"
            
        Returns:
            Context7 library ID or None if not found
        """
        if not self.api_key:
            print("[Context7] No API key configured - cannot resolve library")
            return None
            
        print(f"[Context7] Resolving library: {library_name}")
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(
                    f"{self.base_url}/library/resolve",
                    params={"name": library_name},
                    headers=self._get_headers()
                )
                
                if response.status_code == 200:
                    data = response.json()
                    library_id = data.get("id") or data.get("library_id")
                    print(f"[Context7] Resolved to: {library_id}")
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
        max_tokens: int = 10000
    ) -> str:
        """
        Get documentation for a library.
        
        Args:
            library_id: Context7 library ID (from resolve_library_id)
            topic: Specific topic to focus on (e.g., "hooks", "routing")
            max_tokens: Maximum tokens to retrieve
            
        Returns:
            Documentation content as string
        """
        if not self.api_key:
            print("[Context7] No API key configured - cannot fetch docs")
            return ""
            
        print(f"[Context7] Fetching docs for library: {library_id}")
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                params = {"tokens": max_tokens}
                if topic:
                    params["topic"] = topic
                    
                response = await client.get(
                    f"{self.base_url}/library/{library_id}/docs",
                    params=params,
                    headers=self._get_headers()
                )
                
                if response.status_code == 200:
                    data = response.json()
                    docs = data.get("content", "") or data.get("docs", "")
                    print(f"[Context7] ✓ Retrieved {len(docs)} chars of documentation")
                    return docs
                else:
                    print(f"[Context7] Docs fetch failed: HTTP {response.status_code}")
                    return ""
                    
        except Exception as e:
            print(f"[Context7] Docs fetch error: {e}")
            return ""
    
    async def research_technology(
        self,
        technology: str,
        topic: Optional[str] = None
    ) -> str:
        """
        Convenience method: Resolve library and get docs in one call.
        
        Args:
            technology: Technology name (e.g., "fastapi", "react hooks")
            topic: Optional specific topic to research
            
        Returns:
            Documentation content
        """
        library_id = await self.resolve_library_id(technology)
        if library_id:
            return await self.get_library_docs(library_id, topic=topic)
        return ""


# Global instances (initialized when API keys are available)
skills_loader: Optional[SkillsLoader] = None
context7_client: Optional[Context7Client] = None


def init_research_tools(context7_api_key: Optional[str] = None):
    """
    Initialize research tools with API keys from environment.
    Called during worker startup after API keys are injected.
    """
    global skills_loader, context7_client
    
    api_key = context7_api_key or CONTEXT7_API_KEY
    
    skills_loader = SkillsLoader()
    context7_client = Context7Client(api_key=api_key)
    
    print(f"[ResearchTools] Initialized - Context7: {'✓' if api_key else '✗ (no key)'}")


# =============================================================================
# Tool Functions for Hermes Agent
# =============================================================================

async def load_skills_for_task(skill_names: str) -> dict:
    """
    Load skills from skills.sh before task execution.
    
    Args:
        skill_names: Comma-separated list of skill names (e.g., "python,fastapi,sql")
        
    Returns:
        Summary of loaded skills
    """
    if not skills_loader:
        init_research_tools()
    
    skills = [s.strip() for s in skill_names.split(",")]
    results = await skills_loader.load_skills(skills)
    
    success_count = sum(1 for r in results.values() if "error" not in r)
    return {
        "success": True,
        "loaded": success_count,
        "total": len(skills),
        "details": results
    }


async def research_with_context7(library_name: str, topic: Optional[str] = None) -> str:
    """
    Research a technology using Context7 API.
    
    Args:
        library_name: Name of library to research (e.g., "fastapi", "react", "/mongodb/mongodb-java-driver")
        topic: Optional specific topic (e.g., "authentication", "hooks")
        
    Returns:
        Documentation/research content
    """
    if not context7_client:
        init_research_tools()
    
    docs = await context7_client.research_technology(library_name, topic=topic)
    return docs if docs else "No documentation found"


def get_research_capabilities() -> dict:
    """
    Check available research capabilities and API key status.
    """
    return {
        "skills_sh_available": skills_loader is not None,
        "context7_available": context7_client is not None and bool(context7_client.api_key),
        "context7_api_key_set": bool(CONTEXT7_API_KEY)
    }
