"""
Worker Checkpoint Manager — Fast Recovery for Worker Crashes

Architecture:
- Worker auto-saves checkpoint every N iterations (or configurable interval)
- Checkpoint = serialized agent state (messages, context, iteration, tools)
- On restart: new worker instance loads checkpoint and resumes from last position
- Checkpoint stored on shared/volatile volume (Redis or file) so PM can trigger recovery

Checkpoint is NOT persistent storage — it's a recovery mechanism.
Task progress is always stored in Taiga, not in checkpoints.

Checkpoint contains:
- messages[]: conversation history (last N messages to avoid bloat)
- context: agent context (ticket_id, role, iteration, task progress)
- iteration: current iteration count
- last_action: description of what agent was doing
- created_at: timestamp for staleness check
"""

import os
import json
import time
import base64
import zlib
from typing import Optional
from dataclasses import dataclass, asdict


CHECKPOINT_INTERVAL = 5  # Save every N iterations
CHECKPOINT_PATH = os.environ.get('CHECKPOINT_PATH', '/tmp/worker-checkpoint.json')
CHECKPOINT_COMPRESS = True  # Compress to save space


@dataclass
class Checkpoint:
    ticket_id: str
    role: str
    iteration: int
    messages_summary: str  # Compressed + base64 of messages
    context: dict
    last_action: str
    created_at: float


class CheckpointManager:
    """
    Saves and restores worker state for fast crash recovery.
    
    Usage:
        cm = CheckpointManager(ticket_id="TASK-123", role="pm")
        
        # Save checkpoint (call every N iterations)
        cm.save(agent, last_action="Calling update_ticket_status")
        
        # Load checkpoint (call on worker restart)
        state = cm.load()
        if state:
            agent.restore(state)
            
        # Notify PM about checkpoint
        cm.notify_orchestrator(event='checkpoint_saved', iteration=n)
    """

    def __init__(
        self,
        ticket_id: str,
        role: str,
        interval: int = CHECKPOINT_INTERVAL,
        checkpoint_path: str = CHECKPOINT_PATH,
    ):
        self.ticket_id = ticket_id
        self.role = role
        self.interval = interval
        self.checkpoint_path = checkpoint_path
        self._last_save_time = 0
        self._save_count = 0
        self._orchestrator_url = os.environ.get(
            'ORCHESTRATOR_URL',
            'http://turing-orchestrator:3001'
        )

    def should_save(self, current_iteration: int) -> bool:
        """Check if checkpoint should be saved this iteration"""
        return current_iteration > 0 and current_iteration % self.interval == 0

    def save(self, agent, last_action: str = '') -> bool:
        """
        Save checkpoint of agent state.
        
        Args:
            agent: HermesAgent instance
            last_action: Description of what was just done
            
        Returns:
            True if saved successfully
        """
        try:
            # Serialize messages (compress to save space)
            messages_data = [
                {
                    'role': m.role,
                    'content': m.content[:5000] if m.content else '',  # Truncate long content
                    'tool_calls': [
                        {'name': tc.name, 'arguments': tc.arguments}
                        for tc in (m.tool_calls or [])
                    ]
                }
                for m in agent.messages[-30:]  # Keep last 30 messages
            ]
            messages_json = json.dumps(messages_data, ensure_ascii=False)
            
            # Compress to reduce size
            if CHECKPOINT_COMPRESS:
                messages_bytes = messages_json.encode('utf-8')
                messages_compressed = zlib.compress(messages_bytes, level=6)
                messages_summary = base64.b64encode(messages_compressed).decode('ascii')
            else:
                messages_summary = messages_json

            checkpoint = Checkpoint(
                ticket_id=self.ticket_id,
                role=self.role,
                iteration=agent.context.get('iteration', 0),
                messages_summary=messages_summary,
                context={
                    'ticket_id': agent.context.get('ticket_id'),
                    'role': agent.context.get('role'),
                    'task': agent.context.get('task', ''),
                    'checkpoint_num': self._save_count + 1,
                },
                last_action=last_action[:500],
                created_at=time.time(),
            )

            # Write atomically (write to temp then rename)
            temp_path = self.checkpoint_path + '.tmp'
            with open(temp_path, 'w', encoding='utf-8') as f:
                json.dump(asdict(checkpoint), f, ensure_ascii=False)
            
            # Atomic rename
            if os.path.exists(self.checkpoint_path):
                os.remove(self.checkpoint_path)
            os.rename(temp_path, self.checkpoint_path)

            self._last_save_time = time.time()
            self._save_count += 1
            
            print(f"[Checkpoint] ✓ Saved checkpoint #{self._save_count} "
                  f"(iteration={checkpoint.iteration}, path={self.checkpoint_path})")
            
            # Notify orchestrator about checkpoint
            self.notify_orchestrator('checkpoint_saved', checkpoint.iteration)
            
            return True

        except Exception as e:
            print(f"[Checkpoint] ✗ Failed to save checkpoint: {e}")
            return False

    def load(self) -> Optional[dict]:
        """
        Load checkpoint from disk.
        
        Returns:
            Dict with checkpoint data, or None if no checkpoint exists
        """
        if not os.path.exists(self.checkpoint_path):
            print(f"[Checkpoint] No checkpoint found at {self.checkpoint_path}")
            return None

        try:
            with open(self.checkpoint_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            checkpoint = Checkpoint(**data)
            
            # Check if stale (> 30 minutes old)
            age_seconds = time.time() - checkpoint.created_at
            if age_seconds > 1800:
                print(f"[Checkpoint] ⚠ Checkpoint is {age_seconds/60:.1f} minutes old — may be stale")
            
            print(f"[Checkpoint] ✓ Loaded checkpoint "
                  f"(iteration={checkpoint.iteration}, age={age_seconds:.0f}s)")
            return data

        except Exception as e:
            print(f"[Checkpoint] ✗ Failed to load checkpoint: {e}")
            return None

    def restore(self, agent, checkpoint_data: dict) -> bool:
        """
        Restore agent state from checkpoint.
        
        Args:
            agent: HermesAgent instance
            checkpoint_data: Loaded checkpoint dict
            
        Returns:
            True if restored successfully
        """
        try:
            from agent.hermes_loop import AgentMessage, ToolCall
            
            checkpoint = Checkpoint(**checkpoint_data)
            
            # Restore context
            agent.context['iteration'] = checkpoint.iteration
            if checkpoint.context.get('task'):
                agent.context['task'] = checkpoint.context['task']
            
            # Decompress and restore messages
            messages_summary = checkpoint.messages_summary
            try:
                # Try to decompress (if compressed)
                messages_compressed = base64.b64decode(messages_summary)
                messages_json = zlib.decompress(messages_compressed).decode('utf-8')
            except Exception:
                # Not compressed, treat as plain JSON
                messages_json = messages_summary
            
            messages_data = json.loads(messages_json)
            
            # Reconstruct AgentMessage objects
            agent.messages = []
            for m in messages_data:
                tool_calls = [
                    ToolCall(name=tc['name'], arguments=tc['arguments'])
                    for tc in (m.get('tool_calls') or [])
                ]
                agent.messages.append(AgentMessage(
                    role=m['role'],
                    content=m['content'],
                    tool_calls=tool_calls,
                ))
            
            print(f"[Checkpoint] ✓ Restored {len(agent.messages)} messages, "
                  f"iteration={checkpoint.iteration}")
            return True

        except Exception as e:
            print(f"[Checkpoint] ✗ Failed to restore checkpoint: {e}")
            return False

    def notify_orchestrator(self, event: str, iteration: int = 0):
        """Notify orchestrator about checkpoint event"""
        try:
            import requests
            from orchestrator_auth import orchestrator_headers
            requests.post(
                f'{self._orchestrator_url}/webhooks/checkpoint',
                json={
                    'ticket_id': self.ticket_id,
                    'role': self.role,
                    'event': event,
                    'iteration': iteration,
                    'save_count': self._save_count,
                    'timestamp': time.time(),
                },
                headers=orchestrator_headers(),
                timeout=5,
            )
        except Exception as e:
            print(f"[Checkpoint] Failed to notify orchestrator: {e}")

    def clear(self):
        """Remove checkpoint file"""
        try:
            if os.path.exists(self.checkpoint_path):
                os.remove(self.checkpoint_path)
                print(f"[Checkpoint] Cleared checkpoint at {self.checkpoint_path}")
        except Exception as e:
            print(f"[Checkpoint] Failed to clear checkpoint: {e}")

    def get_last_save_age(self) -> float:
        """Get age of last checkpoint in seconds"""
        if self._last_save_time == 0:
            return -1
        return time.time() - self._last_save_time
