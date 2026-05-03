"""
Worker Health — Heartbeat sender for worker → PM communication.

Sends periodic heartbeats to the orchestrator's HealthMonitor so PM can:
- Track worker liveness (miss 3 heartbeats = DEAD → respawn)
- Detect stuck workers (no progress for 10 min)
- Monitor resource usage (CPU, memory)

This implements the Worker Side of the Health Monitoring Architecture
defined in worker-health.md.
"""

import os
import threading
import time as time_module
from typing import Optional

# ─── Configuration ──────────────────────────────────────────────────────────
HEARTBEAT_INTERVAL = 120  # seconds (2 minutes)
HEARTBEAT_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
HEARTBEAT_ENDPOINT = f"{HEARTBEAT_URL}/webhooks/heartbeat"

TICKET_ID = os.environ.get('TICKET_ID', '')
ROLE = os.environ.get('ROLE', 'default')


class WorkerHealth:
    """
    Sends heartbeats to the orchestrator's HealthMonitor.
    
    Usage:
        health = WorkerHealth(ticket_id="TASK-123", role="pm")
        health.start()  # Start sending heartbeats in background thread
        health.send_progress()  # Call after meaningful work
        health.stop()  # Stop on worker exit
    """

    def __init__(
        self,
        ticket_id: str,
        role: str = 'default',
        interval: int = HEARTBEAT_INTERVAL,
    ):
        self.ticket_id = ticket_id
        self.role = role
        self.interval = interval
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._last_heartbeat = 0
        self._last_progress = 0
        self._current_task = ''
        self._status = 'idle'  # 'working', 'idle', 'blocked'

    def start(self):
        """Start the heartbeat thread"""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        print(f"[WorkerHealth] Started heartbeat (ticket={self.ticket_id}, interval={self.interval}s)")

    def stop(self):
        """Stop the heartbeat thread"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        print(f"[WorkerHealth] Stopped heartbeat for ticket={self.ticket_id}")

    def set_status(self, status: str):
        """Update worker status: 'working', 'idle', 'blocked'"""
        self._status = status

    def set_current_task(self, task: str):
        """Update current task description for progress tracking"""
        self._current_task = task

    def send_progress(self, progress_info: str = ''):
        """
        Send a progress heartbeat — called after meaningful work.
        Updates lastProgress timestamp on the PM side.
        """
        self._last_progress = time_module.time()
        self._status = 'working'
        if progress_info:
            self._current_task = progress_info
        self._send_heartbeat(progress=progress_info or self._current_task)

    def _heartbeat_loop(self):
        """Background thread: send heartbeat every interval seconds"""
        while self._running:
            self._send_heartbeat()
            time_module.sleep(self.interval)

    def _send_heartbeat(self, progress: str = ''):
        """Send heartbeat to orchestrator"""
        import requests

        payload = {
            'ticket_id': self.ticket_id,
            'role': self.role,
            'status': self._status,
            'current_task': self._current_task or 'idle',
            'progress': progress or '',
            'timestamp': time_module.time(),
        }

        # Add resource usage if psutil is available
        try:
            import psutil
            payload['cpu_percent'] = psutil.cpu_percent(interval=0.1)
            payload['memory_mb'] = psutil.virtual_memory().used / (1024 * 1024)
        except ImportError:
            pass

        try:
            resp = requests.post(
                HEARTBEAT_ENDPOINT,
                json=payload,
                timeout=10,
            )
            if resp.status_code == 200:
                self._last_heartbeat = time_module.time()
            else:
                print(f"[WorkerHealth] Heartbeat failed: {resp.status_code}")
        except requests.exceptions.RequestException as e:
            print(f"[WorkerHealth] Heartbeat error: {e}")


# ─── Convenience function for standalone use ────────────────────────────────

_health_instance: Optional[WorkerHealth] = None


def start_health_monitor(ticket_id: str, role: str = 'default') -> WorkerHealth:
    """Start the global health monitor instance"""
    global _health_instance
    _health_instance = WorkerHealth(ticket_id, role)
    _health_instance.start()
    return _health_instance


def stop_health_monitor():
    """Stop the global health monitor instance"""
    global _health_instance
    if _health_instance:
        _health_instance.stop()
        _health_instance = None


def get_health_instance() -> Optional[WorkerHealth]:
    """Get the global health monitor instance"""
    return _health_instance
