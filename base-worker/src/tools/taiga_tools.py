"""
Taiga Tool Interface
Functions for reading and updating tickets (User Stories) on Taiga.
STRICT RULE: All state must be stored in Taiga, not in worker memory.
"""

import os
import json
from typing import Optional

TAIGA_API_URL = os.environ.get('TAIGA_API_URL', 'http://taiga-gateway:80/api/v1')
TAIGA_AUTH_URL = os.environ.get('TAIGA_AUTH_URL', 'http://taiga-gateway:80/api/v1')
TAIGA_API_KEY = os.environ.get('TAIGA_API_KEY', '')
TAIGA_PROJECT_SLUG = os.environ.get('TAIGA_PROJECT_SLUG', 'turing-os')


def _make_request(method: str, endpoint: str, data: dict = None, retries: int = 2) -> dict:
    """Internal helper for making API requests to Taiga with retry"""
    import requests
    import time as time_module

    url = f"{TAIGA_API_URL}{endpoint}"
    headers = {
        'Authorization': f'Bearer {TAIGA_API_KEY}',
        'Content-Type': 'application/json',
    }

    for attempt in range(retries + 1):
        try:
            if method == 'GET':
                resp = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                resp = requests.post(url, headers=headers, json=data, timeout=10)
            elif method == 'PATCH':
                resp = requests.patch(url, headers=headers, json=data, timeout=10)
            elif method == 'DELETE':
                resp = requests.delete(url, headers=headers, timeout=10)
            else:
                return {'error': f'Unsupported method: {method}'}

            if resp.status_code == 204:
                return {'success': True}

            resp.raise_for_status()
            return resp.json() if resp.content else {'success': True}

        except requests.exceptions.RequestException as e:
            print(f"[Taiga] API request failed (attempt {attempt + 1}/{retries + 1}): {e}")
            if attempt < retries:
                time_module.sleep(1 * (attempt + 1))
                continue
            return {'error': str(e)}


def update_ticket_status(ticket_id: str, new_status: str, comment: str = "") -> dict:
    """
    Update a ticket's status in Taiga. LLM MUST call this when task is completed or blocked.
    Valid statuses: 'IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED', 'TODO'

    This is the ONLY way the worker should update ticket state.
    When status is BLOCKED, this also notifies the Orchestrator.

    Note: Taiga uses project-specific status IDs (not numeric codes).
    This function resolves the status name to the actual project status ID.
    """
    print(f"[Taiga] Updating ticket {ticket_id} → {new_status}")
    if comment:
        print(f"[Taiga] Comment: {comment[:200]}")

    # Resolve the actual Taiga status ID from the project's status list
    taiga_status = _resolve_status_id(new_status)
    if taiga_status is None:
        return {'error': f'Unknown status: {new_status}'}

    result = _make_request('PATCH', f'/userstories/{ticket_id}', {
        'status': taiga_status,
    })

    # Add comment if provided
    if comment and 'error' not in result:
        _make_request('POST', f'/userstories/{ticket_id}/comments', {
            'comment': comment,
        })

    # If BLOCKED, notify orchestrator only after Taiga accepted the state change.
    if new_status.upper() == 'BLOCKED' and 'error' not in result:
        _notify_blocked(ticket_id, comment or 'No additional details provided')
    elif new_status.upper() == 'BLOCKED':
        print(f"[Taiga] Skipping blocked notification because ticket state update failed: {result.get('error')}")

    return result


def _resolve_status_id(status_name: str) -> Optional[int]:
    """
    Resolve a human-readable status name to the actual Taiga status ID.
    Taiga statuses are project-specific, so we query the project's status list.
    Falls back to known common IDs if the project query fails.
    """
    status_name_upper = status_name.upper()

    # Common Taiga status name → ID mapping (project-specific, but these are typical)
    # These are the default status IDs in a fresh Taiga project
    common_status_map = {
        'TODO': 1,          # New/Open
        'IN_PROGRESS': 2,   # In Progress
        'REVIEW': 3,        # Ready for test / Review
        'DONE': 4,          # Done / Closed
        'BLOCKED': 5,       # Blocked (common default, not -1)
    }

    # Try to get the actual project status list first
    project_id = _get_project_id()
    if project_id:
        try:
            statuses = _make_request('GET', f'/user-story-statuses?project={project_id}')
            if isinstance(statuses, list):
                # Try to match by name (case-insensitive)
                for s in statuses:
                    s_name = s.get('name', '').upper()
                    s_id = s.get('id')
                    if s_name == status_name_upper:
                        return s_id
                    # Fuzzy match for common names
                    if status_name_upper == 'TODO' and s_name in ('NEW', 'OPEN'):
                        return s_id
                    if status_name_upper == 'IN_PROGRESS' and s_name in ('IN PROGRESS', 'IN-PROGRESS'):
                        return s_id
                    if status_name_upper == 'REVIEW' and s_name in ('READY FOR TEST', 'IN REVIEW'):
                        return s_id
                    if status_name_upper == 'DONE' and s_name in ('DONE', 'CLOSED'):
                        return s_id
                    if status_name_upper == 'BLOCKED' and 'BLOCK' in s_name:
                        return s_id
        except Exception:
            pass

    # Fallback to common mapping
    return common_status_map.get(status_name_upper)


def _notify_blocked(ticket_id: str, reason: str) -> None:
    """Notify the orchestrator that a worker is blocked."""
    orchestrator_url = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')

    try:
        import requests
        requests.post(
            f'{orchestrator_url}/webhooks/blocked',
            json={'ticket_id': ticket_id, 'reason': reason},
            timeout=5,
        )
        print(f"[Taiga] Notified orchestrator about blocked ticket: {ticket_id}")
    except Exception as e:
        print(f"[Taiga] Failed to notify orchestrator: {e}")


def read_ticket(ticket_id: str) -> dict:
    """
    Read full ticket details from Taiga.
    Returns title, description, status, assignees, priority, etc.
    """
    print(f"[Taiga] Reading ticket: {ticket_id}")

    result = _make_request('GET', f'/userstories/{ticket_id}')

    if 'error' in result:
        print(f"[Taiga] Failed to read ticket (will use fallback): {result['error']}")
        return {
            'id': ticket_id,
            'status': 'TODO',
            'title': f'Ticket {ticket_id}',
            'description': 'Task description from Taiga (fallback — Taiga unavailable)',
            'project': TAIGA_PROJECT_SLUG,
        }

    # Normalize Taiga response to a flat dict for easier LLM consumption
    normalized = {
        'id': result.get('id'),
        'ref': result.get('ref'),
        'title': result.get('subject', ''),
        'description': result.get('description', ''),
        'status': result.get('status', 1),
        'project': result.get('project', ''),
        'assigned_to': result.get('assigned_to'),
        'owner': result.get('owner'),
        'priority': result.get('priority'),
        'tags': result.get('tags', []),
        'created_date': result.get('created_date'),
        'modified_date': result.get('modified_date'),
    }

    return normalized


def add_comment(ticket_id: str, comment: str) -> dict:
    """
    Add a comment to a ticket on Taiga.
    Use this to provide progress updates or block reasons.
    """
    print(f"[Taiga] Adding comment to ticket {ticket_id}")

    result = _make_request('POST', f'/userstories/{ticket_id}/comments', {
        'comment': comment,
    })

    return result


def create_ticket(title: str, description: str = "", priority: str = "P2", status: str = "TODO") -> dict:
    """
    Create a new ticket in Taiga. Used for creating subtasks or new work items.

    Args:
        title: Ticket title
        description: Full description of the task
        priority: Priority level (P0=Highest, P1=High, P2=Medium, P3=Low)
        status: Initial status (default: TODO = 1)
    """
    print(f"[Taiga] Creating ticket: {title} (priority: {priority})")

    # Taiga priority: 1=Highest, 2=High, 3=Normal, 4=Low, 5=Lowest
    priority_map = {'P0': 1, 'P1': 2, 'P2': 3, 'P3': 4}
    taiga_priority = priority_map.get(priority.upper(), 3)

    # Status: 1=Open, 2=In Progress, 3=Review, 4=Done, -1=Blocked
    status_map = {'IN_PROGRESS': 2, 'REVIEW': 3, 'DONE': 4, 'BLOCKED': -1, 'TODO': 1}
    taiga_status = status_map.get(status.upper(), 1)

    # First resolve project ID from slug
    project_id = _get_project_id()
    if not project_id:
        return {'error': f'Project not found: {TAIGA_PROJECT_SLUG}'}

    result = _make_request('POST', '/userstories', {
        'project': project_id,
        'subject': title,
        'description': description,
        'priority': taiga_priority,
        'status': taiga_status,
    })

    if 'error' in result:
        print(f"[Taiga] Failed to create ticket: {result['error']}")

    return result


def _get_project_id() -> Optional[int]:
    """Resolve project slug to project ID"""
    result = _make_request('GET', f'/projects/by_slug/{TAIGA_PROJECT_SLUG}')
    if 'error' not in result:
        return result.get('id')
    return None


def search_tickets(query: str, status: Optional[str] = None) -> list:
    """
    Search for tickets in Taiga matching a query string.
    Optionally filter by status.

    Args:
        query: Search query (uses Taiga's full-text search via ?q= parameter)
        status: Optional status filter (uses project-specific status ID)
    """
    print(f"[Taiga] Searching tickets: {query} (status: {status})")

    project_id = _get_project_id()
    if not project_id:
        return []

    # Use Taiga's built-in full-text search parameter (?q=)
    endpoint = f'/userstories?project={project_id}&q={query}'
    if status:
        # Resolve status name to actual ID
        status_id = _resolve_status_id(status)
        if status_id:
            endpoint += f'&status={status_id}'

    result = _make_request('GET', endpoint)

    if 'error' in result:
        print(f"[Taiga] Search failed: {result['error']}")
        return []

    return result if isinstance(result, list) else result.get('tickets', result.get('results', []))


def list_tickets(status: Optional[str] = None) -> list:
    """
    List all tickets, optionally filtered by status.
    Status: 1=Open, 2=In Progress, 3=Review, 4=Done, -1=Blocked
    """
    print(f"[Taiga] Listing tickets, status filter: {status}")

    project_id = _get_project_id()
    if not project_id:
        return []

    endpoint = f'/userstories?project={project_id}'
    if status:
        endpoint += f'&status={status}'

    result = _make_request('GET', endpoint)

    if 'error' in result:
        print(f"[Taiga] Failed to list tickets: {result['error']}")
        return []

    return result if isinstance(result, list) else result.get('tickets', [])
