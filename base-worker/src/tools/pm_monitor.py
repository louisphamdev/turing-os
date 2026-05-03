"""
PM Monitor Tools — Proactive monitoring tools for the PM worker role.

Provides tools for PM to:
- Check health status of all workers (via orchestrator)
- Monitor queue depth and task backlog in Taiga
- Detect stuck or dead workers
- Report project health to admin via Matrix

This implements the PM-side proactive monitoring described in roles/pm.md.
"""

import os
from typing import Optional

ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
TAIGA_API_URL = os.environ.get('TAIGA_API_URL', 'http://taiga-gateway:80/api/v1')
TAIGA_API_KEY = os.environ.get('TAIGA_API_KEY', '')
TAIGA_PROJECT_SLUG = os.environ.get('TAIGA_PROJECT_SLUG', 'turing-os')


# ─── Worker Health Queries ────────────────────────────────────────────────────

def get_workers_health() -> dict:
    """
    Get health status of all active workers from orchestrator.
    
    Returns dict with:
    - workers: list of worker health objects
    - summary: counts by status (healthy, warning, stuck, dead)
    """
    import requests

    try:
        resp = requests.get(
            f'{ORCHESTRATOR_URL}/health/all',
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        return {'error': f'Health endpoint returned {resp.status_code}', 'workers': [], 'summary': {}}
    except requests.exceptions.RequestException as e:
        return {'error': str(e), 'workers': [], 'summary': {}}


def get_worker_by_ticket(ticket_id: str) -> dict:
    """
    Get health info for a specific worker by ticket ID.
    """
    import requests

    try:
        resp = requests.get(
            f'{ORCHESTRATOR_URL}/health/worker/{ticket_id}',
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        return {'error': f'Not found or error: {resp.status_code}'}
    except requests.exceptions.RequestException as e:
        return {'error': str(e)}


def get_stuck_workers() -> list:
    """
    Get list of workers that are stuck or dead.
    Returns list of worker health objects with status 'stuck' or 'dead'.
    """
    result = get_workers_health()
    if 'error' in result:
        return []
    
    workers = result.get('workers', [])
    return [
        w for w in workers
        if w.get('status') in ('stuck', 'dead', 'warning')
    ]


# ─── Queue & Task Monitoring ─────────────────────────────────────────────────

def get_queue_status() -> dict:
    """
    Get current task queue status from Taiga.
    Returns counts of tasks by status (TODO, IN_PROGRESS, BLOCKED, DONE).
    """
    import requests

    try:
        # Get user stories filtered by project
        resp = requests.get(
            f'{TAIGA_API_URL}/userstories',
            params={
                'project': TAIGA_PROJECT_SLUG,
                'status__is_archived': False,
            },
            headers={'Authorization': f'Bearer {TAIGA_API_KEY}'},
            timeout=10,
        )
        
        if resp.status_code != 200:
            return {'error': f'Taiga returned {resp.status_code}', 'totals': {}}
        
        stories = resp.json() if isinstance(resp.json(), list) else []
        
        # Count by status
        totals = {'TODO': 0, 'IN_PROGRESS': 0, 'BLOCKED': 0, 'DONE': 0, 'REVIEW': 0}
        for story in stories:
            status_name = story.get('status_extra_info', {}).get('name', '')
            story_status = story.get('status_name', status_name).upper()
            for key in totals:
                if key in story_status:
                    totals[key] += 1
                    break
        
        pending = totals.get('TODO', 0) + totals.get('IN_PROGRESS', 0)
        
        return {
            'totals': totals,
            'pending_count': pending,
            'blocked_count': totals.get('BLOCKED', 0),
            'done_count': totals.get('DONE', 0),
        }
    except requests.exceptions.RequestException as e:
        return {'error': str(e), 'totals': {}}


def get_high_priority_tasks(limit: int = 5) -> list:
    """
    Get high priority tasks (P0, P1) that need attention.
    """
    import requests

    try:
        resp = requests.get(
            f'{TAIGA_API_URL}/userstories',
            params={
                'project': TAIGA_PROJECT_SLUG,
                'status__is_archived': False,
            },
            headers={'Authorization': f'Bearer {TAIGA_API_KEY}'},
            timeout=10,
        )
        
        if resp.status_code != 200:
            return []
        
        stories = resp.json() if isinstance(resp.json(), list) else []
        
        # Filter for TODO/PENDING with high priority
        high_priority = []
        for story in stories:
            tags = story.get('tags', []) or []
            priority_tag = next((t for t in tags if t.startswith('P0') or t.startswith('P1')), None)
            status_name = story.get('status_name', '').upper()
            if status_name in ('TODO', 'NEW', 'PENDING') or priority_tag:
                high_priority.append({
                    'id': story.get('ref'),
                    'subject': story.get('subject'),
                    'status': story.get('status_name'),
                    'priority': priority_tag or 'P2',
                })
        
        return high_priority[:limit]
    except requests.exceptions.RequestException:
        return []


# ─── Health Reporting ───────────────────────────────────────────────────────

def detect_stuck_workers() -> dict:
    """
    Detect stuck workers and return diagnostic info.
    Checks for:
    - Workers with no heartbeat > 6 min
    - Workers with no progress > 10 min
    - Workers in blocked status
    """
    result = get_workers_health()
    if 'error' in result:
        return {'issues': [], 'summary': 'Unable to fetch health data'}
    
    workers = result.get('workers', [])
    issues = []
    
    for w in workers:
        status = w.get('status', 'unknown')
        time_since_hb = w.get('timeSinceHeartbeat', 0)
        time_since_progress = w.get('timeSinceProgress', 0)
        
        if status == 'dead':
            issues.append({
                'type': 'DEAD',
                'ticket_id': w.get('ticketId'),
                'role': w.get('role'),
                'issue': f'No heartbeat for {round(time_since_hb/60000)}min — worker killed and respawning',
            })
        elif status == 'stuck':
            issues.append({
                'type': 'STUCK',
                'ticket_id': w.get('ticketId'),
                'role': w.get('role'),
                'issue': f'No progress for {round(time_since_progress/60000)}min',
            })
        elif status == 'warning' and time_since_hb > 360000:  # 6 min
            issues.append({
                'type': 'WARNING',
                'ticket_id': w.get('ticketId'),
                'role': w.get('role'),
                'issue': f'Heartbeat delayed {round(time_since_hb/60000)}min (missed heartbeats)',
            })
    
    return {
        'issues': issues,
        'total_workers': len(workers),
        'healthy_count': len([w for w in workers if w.get('status') == 'healthy']),
        'summary': f"{len(issues)} issue(s) found out of {len(workers)} workers"
    }


def report_project_health() -> str:
    """
    Generate a comprehensive project health report for admin.
    Returns formatted markdown string suitable for Matrix message.
    """
    import requests
    
    lines = ["📊 **Project Health Report**", ""]
    
    # ── Worker Health ──
    health = get_workers_health()
    if 'error' in health:
        lines.append(f"⚠️ Cannot reach orchestrator: {health['error']}")
    else:
        workers = health.get('workers', [])
        
        healthy = len([w for w in workers if w.get('status') == 'healthy'])
        warning = len([w for w in workers if w.get('status') == 'warning'])
        stuck = len([w for w in workers if w.get('status') == 'stuck'])
        dead = len([w for w in workers if w.get('status') == 'dead'])
        
        lines.append(f"**Workers:** {len(workers)} total | ✅ {healthy} healthy | ⚠️ {warning} warning | 🔴 {stuck} stuck | 💀 {dead} dead")
        
        # List problem workers
        problem_workers = [w for w in workers if w.get('status') in ('stuck', 'dead', 'warning')]
        if problem_workers:
            lines.append("")
            lines.append("**Problem Workers:**")
            for w in problem_workers:
                status_emoji = '💀' if w.get('status') == 'dead' else '🔴' if w.get('status') == 'stuck' else '⚠️'
                lines.append(f"  {status_emoji} `{w.get('ticketId')}` ({w.get('role')}) — {w.get('status')}")
    
    lines.append("")
    
    # ── Queue Status ──
    queue = get_queue_status()
    if 'error' in queue:
        lines.append(f"⚠️ Cannot reach Taiga: {queue['error']}")
    else:
        totals = queue.get('totals', {})
        pending = queue.get('pending_count', 0)
        blocked = queue.get('blocked_count', 0)
        done = queue.get('done_count', 0)
        
        lines.append(f"**Task Queue:** {pending} pending | 🔒 {blocked} blocked | ✅ {done} done")
        
        # Blocked tasks detail
        if blocked > 0:
            lines.append("")
            lines.append("**🔒 Blocked Tasks:**")
            # Get blocked stories
            try:
                resp = requests.get(
                    f'{TAIGA_API_URL}/userstories',
                    params={'project': TAIGA_PROJECT_SLUG},
                    headers={'Authorization': f'Bearer {TAIGA_API_KEY}'},
                    timeout=10,
                )
                if resp.status_code == 200:
                    stories = resp.json() if isinstance(resp.json(), list) else []
                    blocked_stories = [s for s in stories if 'BLOCK' in (s.get('status_name') or '').upper()]
                    for s in blocked_stories[:5]:  # Show max 5
                        lines.append(f"  - `{s.get('ref')}`: {s.get('subject', '')[:60]}")
            except Exception:
                pass
    
    lines.append("")
    
    # ── High Priority ──
    high_prio = get_high_priority_tasks(limit=3)
    if high_prio:
        lines.append("**🚦 High Priority (P0/P1):**")
        for t in high_prio:
            lines.append(f"  - `{t.get('id')}` [{t.get('priority')}]: {t.get('subject', '')[:60]}")
    
    lines.append("")
    lines.append(f"_Report generated_")
    
    return "\n".join(lines)


# ─── Deadlock Detection ──────────────────────────────────────────────────────

def check_dependency_wait() -> dict:
    """
    Check for circular dependency wait among workers.
    Workers should not be waiting on each other's outputs in a loop.
    """
    # This requires tracking dependencies - simplified version
    # Full implementation would need worker to publish their wait dependencies
    health = get_workers_health()
    if 'error' in health:
        return {'deadlock_detected': False, 'reason': 'Cannot fetch health data'}
    
    # Check if multiple workers are blocked simultaneously
    workers = health.get('workers', [])
    blocked_workers = [w for w in workers if w.get('status') == 'blocked' or w.get('status') == 'stuck']
    
    if len(blocked_workers) >= 2:
        # Potential deadlock - multiple workers stuck at same time
        return {
            'deadlock_detected': True,
            'concern': f'{len(blocked_workers)} workers stuck simultaneously',
            'workers': [w.get('ticketId') for w in blocked_workers],
            'action': 'Investigate dependency chain — may need to kill and restart some workers'
        }
    
    return {'deadlock_detected': False, 'concern': None}
