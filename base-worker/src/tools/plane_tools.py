"""
Plane.so Tool Interface
Functions for reading and updating tickets on Plane
STRICT RULE: All state must be stored in Plane, not in worker memory
"""

import os
import json
from typing import Optional

PLANE_API_URL = os.environ.get('PLANE_API_URL', 'http://plane-api:3000')
PLANE_API_KEY = os.environ.get('PLANE_API_KEY', '')
WORKSPACE_ID = os.environ.get('PLANE_WORKSPACE_ID', '')


def _make_request(method: str, endpoint: str, data: dict = None) -> dict:
    """Internal helper for making API requests to Plane"""
    import requests
    
    url = f"{PLANE_API_URL}{endpoint}"
    headers = {
        'Authorization': f'Bearer {PLANE_API_KEY}',
        'Content-Type': 'application/json'
    }
    
    try:
        if method == 'GET':
            resp = requests.get(url, headers=headers, timeout=10)
        elif method == 'POST':
            resp = requests.post(url, headers=headers, json=data, timeout=10)
        elif method == 'PATCH':
            resp = requests.patch(url, headers=headers, json=data, timeout=10)
        else:
            return {'error': f'Unsupported method: {method}'}
            
        resp.raise_for_status()
        return resp.json() if resp.content else {'success': True}
    except requests.exceptions.RequestException as e:
        print(f"[Plane] API request failed: {e}")
        return {'error': str(e)}


def update_ticket_status(ticket_id: str, new_status: str, comment: str = "") -> dict:
    """
    LLM MUST call this tool when the task is completed or blocked.
    Valid statuses: 'IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED'
    
    This is the ONLY way the worker should update ticket state.
    All state changes MUST go through Plane API - no local state in worker.
    
    When status is BLOCKED, this also notifies the Orchestrator
    which will send a Revolt DM to the admin for human intervention.
    """
    print(f"[Plane] Updating ticket {ticket_id} to status: {new_status}")
    if comment:
        print(f"[Plane] Comment: {comment}")
    
    # Map our status to Plane's expected format
    status_map = {
        'IN_PROGRESS': 'in_progress',
        'REVIEW': 'review', 
        'DONE': 'done',
        'BLOCKED': 'blocked',
        'TODO': 'todo'
    }
    plane_status = status_map.get(new_status.upper(), new_status.lower())
    
    # Make API call to Plane
    result = _make_request('PATCH', f'/api/v1/workspaces/{WORKSPACE_ID}/tickets/{ticket_id}', {
        'status': plane_status
    })
    
    # Add comment if provided
    if comment and 'error' not in result:
        _make_request('POST', f'/api/v1/workspaces/{WORKSPACE_ID}/tickets/{ticket_id}/comments', {
            'content': comment
        })
    
    # If BLOCKED, notify orchestrator to send Revolt alert
    if new_status.upper() == 'BLOCKED':
        _notify_blocked(ticket_id, comment or 'No additional details provided')
    
    print(f"[Plane] Update result: {result}")
    return result


def _notify_blocked(ticket_id: str, reason: str) -> None:
    """
    Notify the orchestrator that a worker is blocked.
    The orchestrator will send a Revolt DM to the admin.
    """
    import os
    
    orchestrator_url = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3000')
    
    try:
        import requests
        resp = requests.post(
            f'{orchestrator_url}/webhooks/blocked',
            json={'ticket_id': ticket_id, 'reason': reason},
            timeout=5
        )
        print(f"[Plane] Notified orchestrator about blocked ticket: {ticket_id}")
    except Exception as e:
        print(f"[Plane] Failed to notify orchestrator: {e}")


def read_ticket(ticket_id: str) -> dict:
    """
    Read full ticket details from Plane.
    This includes title, description, status, assignees, etc.
    """
    print(f"[Plane] Reading ticket: {ticket_id}")
    
    result = _make_request('GET', f'/api/v1/workspaces/{WORKSPACE_ID}/tickets/{ticket_id}')
    
    if 'error' in result:
        print(f"[Plane] Failed to read ticket: {result['error']}")
        # Return mock data for testing when Plane is not available
        return {
            'id': ticket_id,
            'status': 'TODO',
            'title': f'Ticket {ticket_id}',
            'description': 'Task description from Plane (mock - Plane unavailable)',
            'workspace': WORKSPACE_ID
        }
    
    return result


def add_comment(ticket_id: str, comment: str) -> dict:
    """
    Add a comment to a ticket on Plane.
    Use this to provide progress updates or block reasons.
    """
    print(f"[Plane] Adding comment to ticket {ticket_id}: {comment}")
    
    result = _make_request('POST', f'/api/v1/workspaces/{WORKSPACE_ID}/tickets/{ticket_id}/comments', {
        'content': comment
    })
    
    print(f"[Plane] Comment result: {result}")
    return result


def list_tickets(status: Optional[str] = None) -> list:
    """
    List all tickets, optionally filtered by status.
    Status: 'todo', 'in_progress', 'review', 'done', 'blocked'
    """
    print(f"[Plane] Listing tickets, status filter: {status}")
    
    endpoint = f'/api/v1/workspaces/{WORKSPACE_ID}/tickets'
    if status:
        endpoint += f'?status={status}'
    
    result = _make_request('GET', endpoint)
    
    if 'error' in result:
        print(f"[Plane] Failed to list tickets: {result['error']}")
        return []
    
    return result if isinstance(result, list) else result.get('tickets', [])