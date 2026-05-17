"""
PM Monitor Tools — Proactive monitoring tools for the PM worker role.

Provides tools for PM to:
- Check health status of all workers (via orchestrator)
- Monitor queue depth and task backlog via the active StateBackend
- Detect stuck or dead workers
- Report project health to admin via Matrix

This implements the PM-side proactive monitoring described in roles/pm.md.
Ticket queries go through state_backend.get_backend() so the same code runs
against Taiga or Plane depending on STATE_BACKEND.
"""

import os
from typing import Optional

ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')


def _tickets() -> list[dict]:
    """Return the active backend's normalised ticket list (or empty)."""
    from . import state_backend
    result = state_backend.get_backend().list_tickets()
    if isinstance(result, dict) and "tickets" in result:
        return result["tickets"]
    return []


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
    Get current task queue status from the active StateBackend.
    Returns counts of tasks by status (TODO, IN_PROGRESS, BLOCKED, DONE, REVIEW).
    """
    tickets = _tickets()

    totals = {'TODO': 0, 'IN_PROGRESS': 0, 'BLOCKED': 0, 'DONE': 0, 'REVIEW': 0}
    for ticket in tickets:
        story_status = (ticket.get('status_name') or '').upper().replace('-', '_').replace(' ', '_')
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


def get_high_priority_tasks(limit: int = 5) -> list:
    """
    Get high priority tasks (P0, P1) that need attention.
    Pulled from the active StateBackend; priority comes from tag prefixes
    (P0/P1) or the backend's native priority field if present.
    """
    tickets = _tickets()

    def _priority_tag(tags: list) -> Optional[str]:
        for tag in tags:
            text = str(tag if isinstance(tag, str) else (tag.get('name') if isinstance(tag, dict) else ''))
            if text.startswith('P0') or text.startswith('P1'):
                return text
        return None

    high_priority = []
    for ticket in tickets:
        tags = ticket.get('tags') or []
        priority_tag = _priority_tag(tags)
        status_name = (ticket.get('status_name') or '').upper()
        if status_name in ('TODO', 'NEW', 'PENDING', 'OPEN', 'BACKLOG') or priority_tag:
            high_priority.append({
                'id': ticket.get('ref') or ticket.get('id'),
                'subject': ticket.get('title') or ticket.get('subject') or '',
                'status': ticket.get('status_name'),
                'priority': priority_tag or ticket.get('priority') or 'P2',
            })

    return high_priority[:limit]


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
        lines.append(f"⚠️ Cannot reach ticket backend: {queue['error']}")
    else:
        pending = queue.get('pending_count', 0)
        blocked = queue.get('blocked_count', 0)
        done = queue.get('done_count', 0)

        lines.append(f"**Task Queue:** {pending} pending | 🔒 {blocked} blocked | ✅ {done} done")

        if blocked > 0:
            lines.append("")
            lines.append("**🔒 Blocked Tasks:**")
            blocked_tickets = [t for t in _tickets() if 'BLOCK' in (t.get('status_name') or '').upper()]
            for t in blocked_tickets[:5]:
                title = t.get('title') or t.get('subject') or ''
                lines.append(f"  - `{t.get('ref') or t.get('id')}`: {title[:60]}")
    
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
