"""
Matrix Client Tools for Workers
Provides bidirectional communication between workers and admin via Matrix.

Communication Model:
  Worker → Orchestrator (HTTP) → Matrix Room → Admin (Element)
  Admin (Element) → Matrix Room → Orchestrator (sync) → Worker Inbox → Worker

Tools:
  - ask_admin(question)      — Ask admin a question and wait for reply
  - notify_admin(message)    — Fire-and-forget notification to admin
  - send_matrix_message()    — Direct Matrix room message (low-level)
  - get_matrix_messages()    — Get recent messages from Matrix room
  - poll_admin_inbox()       — Poll orchestrator for admin messages
"""

import os
import time as time_module
import json
import threading
from queue import Queue, Empty
from typing import Optional

MATRIX_API_URL = os.environ.get('SYNAPSE_API_URL', 'http://synapse:8008')
MATRIX_TOKEN = os.environ.get('MATRIX_BOT_TOKEN', '')
MATRIX_ROOM_ID = os.environ.get('MATRIX_ROOM_ID', '')
ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
TICKET_ID = os.environ.get('TICKET_ID', '')


class MatrixClient:
    """Simple Matrix client for worker communication"""

    def __init__(self, homeserver: str, token: str):
        self.homeserver = homeserver.rstrip('/')
        self.token = token
        self.message_queue: Queue = Queue()
        self._running = False
        self._poll_thread: Optional[threading.Thread] = None
        self._user_id: Optional[str] = None

    @property
    def user_id(self) -> Optional[str]:
        """Get the user ID for this token (cached)"""
        if self._user_id is None:
            result = self._request('GET', 'account/whoami')
            if 'user_id' in result:
                self._user_id = result['user_id']
        return self._user_id

    def _request(self, method: str, endpoint: str, data: dict = None) -> dict:
        """Make Matrix API request"""
        import requests

        url = f"{self.homeserver}/_matrix/client/r0/{endpoint}"
        headers = {
            'Authorization': f'Bearer {self.token}',
            'Content-Type': 'application/json',
        }

        try:
            if method == 'GET':
                resp = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                resp = requests.post(url, headers=headers, json=data, timeout=10)
            elif method == 'PUT':
                resp = requests.put(url, headers=headers, json=data, timeout=10)
            else:
                return {'error': f'Unknown method: {method}'}

            if resp.status_code == 200:
                return resp.json() if resp.text else {'success': True}
            else:
                return {'error': f'HTTP {resp.status_code}: {resp.text}'}
        except Exception as e:
            return {'error': str(e)}

    def send_message(self, room_id: str, message: str) -> bool:
        """Send message to a Matrix room"""
        txn_id = f"worker_{int(time_module.time() * 1000)}"
        result = self._request('PUT', f'rooms/{room_id}/send/m.room.message/{txn_id}', {
            'msgtype': 'm.text',
            'body': message,
        })
        return 'error' not in result

    def get_messages(self, room_id: str, limit: int = 10) -> list:
        """Get recent messages from a room"""
        result = self._request('GET', f'rooms/{room_id}/messages?limit={limit}&dir=b')
        if 'error' in result:
            return []
        return result.get('chunk', [])

    def join_room(self, room_id_or_alias: str) -> bool:
        """Join a Matrix room"""
        result = self._request('POST', f'join/{room_id_or_alias}', {})
        return 'error' not in result

    def start_listening(self, room_id: str, callback):
        """Start polling for new messages in background thread"""
        self._running = True
        self._poll_thread = threading.Thread(
            target=self._poll_messages,
            args=(room_id, callback),
            daemon=True
        )
        self._poll_thread.start()

    def _poll_messages(self, room_id: str, callback):
        """Poll for new messages"""
        last_event_id = None

        while self._running:
            try:
                messages = self.get_messages(room_id, limit=5)
                for msg in reversed(messages):
                    event_id = msg.get('event_id')
                    if event_id and event_id != last_event_id:
                        last_event_id = event_id
                        sender = msg.get('sender', '')
                        content = msg.get('content', {}).get('body', '')

                        # Skip our own messages
                        if 'turing-worker' not in sender:
                            callback(sender, content, msg)

                time_module.sleep(3)  # Poll every 3 seconds
            except Exception as e:
                print(f"[Matrix] Poll error: {e}")
                time_module.sleep(5)

    def stop_listening(self):
        """Stop polling"""
        self._running = False
        if self._poll_thread:
            self._poll_thread.join(timeout=2)


# Global client instance
_client: Optional[MatrixClient] = None


def get_matrix_client() -> Optional[MatrixClient]:
    """Get or create Matrix client singleton"""
    global _client
    if _client is None and MATRIX_TOKEN:
        _client = MatrixClient(MATRIX_API_URL, MATRIX_TOKEN)
    return _client


# ─── Orchestrator-Relayed Communication (Preferred) ──────────────────────

def notify_admin(message: str, message_type: str = 'info') -> dict:
    """
    Send a notification to admin via Matrix (fire-and-forget).
    The message is relayed through the orchestrator to the worker's Matrix room.

    Usage: notify_admin("Task completed successfully", "progress")

    Args:
        message: The message to send to admin
        message_type: One of 'info', 'progress', 'question', 'error'
    Returns:
        dict with success status
    """
    import requests
    from orchestrator_auth import orchestrator_headers

    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': TICKET_ID,
                'message': message,
                'message_type': message_type,
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
        if resp.status_code == 200:
            return {'success': True, 'relayed': True}
        else:
            return {'success': False, 'error': f'HTTP {resp.status_code}'}
    except Exception as e:
        # Fallback: send directly via Matrix if orchestrator is unreachable
        return _send_direct_fallback(message)


def ask_admin(question: str, timeout_seconds: int = 300) -> dict:
    """
    Ask admin a question via Matrix and wait for their reply.
    The question is sent to the worker's Matrix room. Admin replies
    are collected from the orchestrator's worker inbox.

    If the timeout is reached, the ticket is marked BLOCKED through the
    existing Taiga → orchestrator blocked flow so the timeout is visible
    at system level instead of staying a local worker-only error.

    Usage: ask_admin("Should I use PostgreSQL or MySQL for this project?")

    Args:
        question: The question to ask the admin
        timeout_seconds: Max seconds to wait for a reply (default: 300 = 5 min)
    Returns:
        dict with 'reply' (admin's response text) or 'timeout' if no reply
    """
    import requests
    from orchestrator_auth import orchestrator_headers

    question_sent_at_ms = int(time_module.time() * 1000)

    # 1. Send the question to admin
    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': TICKET_ID,
                'message': question,
                'message_type': 'question',
                'timeout_seconds': timeout_seconds,
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
        if resp.status_code != 200:
            return {'success': False, 'error': f'Failed to send question: HTTP {resp.status_code}'}
    except Exception as e:
        return {'success': False, 'error': f'Failed to send question: {e}'}

    # 2. Poll the worker inbox for admin's reply
    start_time = time_module.time()
    poll_interval = 3  # seconds

    while time_module.time() - start_time < timeout_seconds:
        messages = poll_admin_inbox(question_sent_at_ms)
        if messages:
            latest = messages[-1]
            return {
                'success': True,
                'reply': latest['content'],
                'sender': latest['sender'],
                'timestamp': latest['timestamp'],
            }

        time_module.sleep(poll_interval)

    timeout_reason = (
        f'admin_response_timeout after {timeout_seconds}s. '
        f'Unanswered question: {question}'
    )
    blocked = False
    status_update = None

    if TICKET_ID:
        try:
            from tools import state_backend

            backend = state_backend.get_backend()
            status_update = backend.update_ticket_status(
                TICKET_ID,
                'BLOCKED',
                timeout_reason,
            )
            blocked = 'error' not in (status_update or {})
            if not blocked:
                notify_admin(
                    (
                        f'Admin timeout after {timeout_seconds}s, but state backend BLOCKED update failed. '
                        f'Reason: {status_update.get("error", "unknown error")}'
                    ),
                    'error',
                )
        except Exception as exc:
            status_update = {'error': str(exc)}
            notify_admin(
                (
                    f'Admin timeout after {timeout_seconds}s, but BLOCKED escalation raised an exception. '
                    f'Reason: {exc}'
                ),
                'error',
            )

    return {
        'success': False,
        'timeout': True,
        'blocked': blocked,
        'error': f'No reply from admin within {timeout_seconds}s',
        'status_update': status_update,
    }


def poll_admin_inbox(since_timestamp_ms: Optional[int] = None) -> list:
    """
    Poll the orchestrator for any pending messages from admin.
    Messages are drained (removed) from the inbox after retrieval.

    Usage: messages = poll_admin_inbox()

    Returns:
        list of dicts with 'sender', 'content', 'timestamp'
    """
    import requests
    from orchestrator_auth import orchestrator_headers

    try:
        params = {}
        if since_timestamp_ms is not None:
            params['since'] = since_timestamp_ms

        resp = requests.get(
            f'{ORCHESTRATOR_URL}/webhooks/worker-inbox/{TICKET_ID}',
            params=params,
            headers=orchestrator_headers(),
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json().get('messages', [])
        return []
    except Exception:
        return []


# ─── Direct Matrix Communication (DEPRECATED) ────────────────────────────
#
# Workers must NOT call the Matrix API with admin credentials — see
# `.claude/rules/architecture.md`. All admin↔worker traffic goes through
# the orchestrator relay. If the orchestrator is unreachable, the right
# response is to surface the error, not to bypass the relay.

def _send_direct_fallback(message: str) -> dict:
    """Disabled — direct Matrix sends bypass the orchestrator relay."""
    return {
        'success': False,
        'error': (
            'Direct Matrix fallback disabled. The worker→admin path must '
            'go through the orchestrator relay (/webhooks/worker-message). '
            'If the orchestrator is unreachable, this message is dropped.'
        ),
    }


def send_matrix_message(room_id: str, message: str) -> dict:
    """
    Send a message to a Matrix room (low-level direct send).
    Prefer notify_admin() for admin communication.

    Usage: send_matrix_message(room_id, "Hello from worker!")
    """
    client = get_matrix_client()
    if not client:
        return {'success': False, 'error': 'Matrix not configured'}

    success = client.send_message(room_id, message)
    return {'success': success}


def get_matrix_messages(room_id: str, limit: int = 10) -> list:
    """
    Get recent messages from a Matrix room (low-level).
    Prefer poll_admin_inbox() for getting admin messages.

    Usage: messages = get_matrix_messages(room_id)
    """
    client = get_matrix_client()
    if not client:
        return []

    return client.get_messages(room_id, limit)
