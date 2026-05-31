"""
Turing Base Worker - Entry Point
Ephemeral container that runs a Hermes agent to process a ticket.
STRICT RULE #1: Zero-State Worker - no persistent state, container dies on exit

Communication Model:
  Worker → Orchestrator (HTTP /webhooks/worker-message) → Matrix Room → Admin
  Admin → Matrix Room → Orchestrator (sync listener) → Worker Inbox → Worker (HTTP poll)
"""

import os
import sys
import time as time_module
import traceback
import threading

# ─── Health Monitoring ────────────────────────────────────────────────────
from health import start_health_monitor, stop_health_monitor

# ─── Configuration from Environment ──────────────────────────────────────
TICKET_ID = os.environ.get('TICKET_ID')
ROLE = os.environ.get('ROLE', 'default')
LLM_API_KEY = os.environ.get('LLM_API_KEY')
LLM_PROVIDER = os.environ.get('LLM_PROVIDER', 'openai')
LLM_MODEL = os.environ.get('LLM_MODEL', 'gpt-4o')
LLM_BASE_URL = os.environ.get('LLM_BASE_URL', 'https://api.openai.com/v1')
ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
MATRIX_ROOM_ID = os.environ.get('MATRIX_ROOM_ID', '')


def log(msg: str, level: str = 'INFO'):
    """Structured logging"""
    ts = time_module.strftime('%Y-%m-%d %H:%M:%S')
    print(f"[{ts}] [{level}] [Worker:{TICKET_ID}] {msg}", flush=True)


def notify_orchestrator(endpoint: str, data: dict):
    """Send notification to orchestrator (best-effort)"""
    try:
        import requests
        from orchestrator_auth import orchestrator_headers
        requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/{endpoint}',
            json=data,
            headers=orchestrator_headers(),
            timeout=5,
        )
    except Exception as e:
        log(f"Failed to notify orchestrator ({endpoint}): {e}", 'WARN')


def create_agent(checkpoint_manager=None):
    """Factory function to create the appropriate agent based on LLM_PROVIDER"""
    from agent.hermes_loop import OpenAIAgent, AnthropicAgent, MiniMaxAgent

    kwargs = {
        'ticket_id': TICKET_ID,
        'role': ROLE,
        'api_key': LLM_API_KEY,
        'model': LLM_MODEL,
        'base_url': LLM_BASE_URL,
        'checkpoint_manager': checkpoint_manager,
    }

    if LLM_PROVIDER == 'anthropic':
        agent = AnthropicAgent(**kwargs)
    elif LLM_PROVIDER == 'minimax':
        agent = MiniMaxAgent(**kwargs)
    else:
        agent = OpenAIAgent(**kwargs)

    # ─── Load methodology skills (local corpus) into the system prompt ────
    _load_startup_skills(agent, ROLE)

    return agent


# Role → superpowers methodology skill files. These are the TERSE
# Turing-flavored translations living in base-worker/skills/<name>.md and are
# the SINGLE source of execution discipline (BMAD + remote skill fetch removed).
ROLE_METHODOLOGY = {
    'po': ['brainstorming', 'writing-plans'],
    'ba': ['brainstorming', 'writing-plans'],
    # PM gets planning + conceptual review/fan-out guidance (orchestrator-mediated;
    # subagent mechanics are intentionally NOT part of the worker skill prose).
    'pm': ['writing-plans'],
    'software-engineer': [
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'receiving-code-review',
    ],
    # Language / spec dev workers share the software-engineer discipline.
    'data': [
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'receiving-code-review',
    ],
    'devops': [
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'receiving-code-review',
    ],
    'security': [
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'receiving-code-review',
    ],
    'network': [
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'receiving-code-review',
    ],
    'qa': ['verification-before-completion', 'requesting-code-review'],
    'doctor': ['systematic-debugging', 'verification-before-completion'],
    'hr': ['brainstorming', 'writing-plans'],
}

# Fallback for unknown roles (incl. the literal 'default' role).
DEFAULT_METHODOLOGY = [
    'test-driven-development',
    'systematic-debugging',
    'verification-before-completion',
]


def _methodology_skills_for_role(role: str) -> list:
    """Map a worker role to its methodology skill file names (per spec)."""
    return ROLE_METHODOLOGY.get((role or '').lower(), DEFAULT_METHODOLOGY)


def _load_startup_skills(agent, role: str):
    """
    Load the role's methodology skills from the LOCAL corpus
    (base-worker/skills/<name>.md) and stash their bodies on
    agent.context['methodology'] so _build_system_prompt can inject a terse
    "## Methodology (mandatory gates)" section.

    Robust if a skill file is missing: it is skipped + logged, the worker
    still boots. No network (remote skill fetch removed).
    """
    skill_names = _methodology_skills_for_role(role)
    log(f"[Startup] Methodology skills for role '{role}': {', '.join(skill_names)}")

    methodology = []
    try:
        from tools.research_tools import load_skill_file
        for name in skill_names:
            body = load_skill_file(name)
            if body:
                methodology.append({'name': name, 'body': body.strip()})
            else:
                log(f"[Startup] ⚠ Methodology skill missing (skipped): {name}.md", 'WARN')
    except Exception as e:
        log(f"[Startup] ⚠ Failed to load methodology skills: {e}", 'WARN')

    agent.context['methodology'] = methodology
    log(f"[Startup] ✓ Loaded {len(methodology)}/{len(skill_names)} methodology skills for role '{role}'")


# ─── Orchestrator-Based Admin Communication ────────────────────────────────

def poll_admin_inbox() -> list:
    """Poll orchestrator for pending admin messages"""
    try:
        import requests
        from orchestrator_auth import orchestrator_headers
        resp = requests.get(
            f'{ORCHESTRATOR_URL}/webhooks/worker-inbox/{TICKET_ID}',
            headers=orchestrator_headers(),
            timeout=5,
        )
        if resp.status_code == 200:
            return resp.json().get('messages', [])
        return []
    except Exception:
        return []


def send_to_admin(message: str, message_type: str = 'info'):
    """Send message to admin via orchestrator → Matrix.

    No direct-Matrix fallback: per the architecture rules, workers must
    never speak Matrix with admin credentials. If the orchestrator is
    unreachable, the message is dropped and surfaced in the log so the
    incident is visible instead of silently bypassing the relay.
    """
    try:
        import requests
        from orchestrator_auth import orchestrator_headers
        requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': TICKET_ID,
                'message': message,
                'message_type': message_type,
            },
            headers=orchestrator_headers(),
            timeout=5,
        )
    except Exception as e:
        log(f"Dropped message to admin (orchestrator unreachable): {e}", 'ERROR')


def _heartbeat_loop():
    """
    Background thread: sends periodic heartbeats to the orchestrator every 2 minutes.
    Reports worker status (idle/working), current task, CPU%, memory MB.
    """
    import requests

    # psutil is optional — a missing/broken install must degrade gracefully
    # (heartbeat still sends, just without CPU/mem) instead of crashing the
    # whole heartbeat thread on import.
    try:
        import psutil
    except Exception:
        psutil = None

    HEARTBEAT_INTERVAL = 120  # seconds

    while True:
        try:
            cpu_percent = None
            mem_mb = None
            if psutil is not None:
                try:
                    cpu_percent = psutil.cpu_percent(interval=1)
                    mem = psutil.virtual_memory()
                    mem_mb = mem.used / 1024 / 1024
                except Exception:
                    cpu_percent = None
                    mem_mb = None

            payload = {
                'ticket_id': TICKET_ID,
                'status': 'working',
                'timestamp': time_module.strftime('%Y-%m-%dT%H:%M:%SZ'),
            }
            if cpu_percent is not None:
                payload['cpu_percent'] = round(cpu_percent, 1)
            if mem_mb is not None:
                payload['memory_mb'] = round(mem_mb, 1)

            from orchestrator_auth import orchestrator_headers
            requests.post(
                f'{ORCHESTRATOR_URL}/webhooks/health/heartbeat',
                json=payload,
                headers=orchestrator_headers(),
                timeout=5,
            )
            log(f"[Heartbeat] sent — CPU:{cpu_percent}% RAM:{mem_mb:.0f}MB" if cpu_percent else "[Heartbeat] sent", 'DEBUG')
        except Exception as e:
            log(f"[Heartbeat] failed: {e}", 'WARN')

        time_module.sleep(HEARTBEAT_INTERVAL)


def main():
    """Main entry point"""
    log(f"Starting — role: {ROLE}, provider: {LLM_PROVIDER}, model: {LLM_MODEL}")

    # ── Validate required env vars ────────────────────────────────────────
    if not TICKET_ID:
        log("FATAL: TICKET_ID environment variable is required", 'ERROR')
        sys.exit(1)

    # Workers run in gateway-only mode now. The orchestrator injects
    # CONSUMER_TOKEN + GATEWAY_URL on spawn; LLM_API_KEY is no longer
    # required in the worker's environment.
    if not os.environ.get('CONSUMER_TOKEN') or not os.environ.get('GATEWAY_URL'):
        log("FATAL: CONSUMER_TOKEN + GATEWAY_URL must be set by the orchestrator on spawn", 'ERROR')
        sys.exit(1)

    # ── Start heartbeat thread ───────────────────────────────────────────
    heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    heartbeat_thread.start()
    log("[Heartbeat] Background thread started (every 120s)")

    try:
        # ── Create checkpoint manager ─────────────────────────────────────
        from checkpoint import CheckpointManager
        checkpoint_path = os.environ.get('CHECKPOINT_PATH', '/tmp/worker-checkpoint.json')
        cm = CheckpointManager(ticket_id=TICKET_ID, role=ROLE, checkpoint_path=checkpoint_path)

        # ── Create agent with checkpoint manager ────────────────────────────
        agent = create_agent(checkpoint_manager=cm)

        # ── Read ticket from active StateBackend (taiga | plane) ───────────
        log("Reading ticket information...")
        from tools import state_backend
        backend = state_backend.get_backend()
        log(f"Using state backend: {backend.name}")
        ticket = backend.read_ticket(TICKET_ID)

        task_description = ticket.get('description', '') or ticket.get('title', 'No task description')
        log(f"Task: {task_description[:200]}...")

        # ── Update ticket to IN_PROGRESS ──────────────────────────────────
        backend.update_ticket_status(TICKET_ID, 'IN_PROGRESS', 'Worker started processing')

        # ── Start health monitoring ────────────────────────────────────────
        health = start_health_monitor(TICKET_ID, ROLE)
        health.set_status('working')
        health.set_current_task(task_description[:100])

        # ── Try to restore from checkpoint ────────────────────────────────
        restored_from_checkpoint = False
        checkpoint_data = cm.load()
        if checkpoint_data and checkpoint_data.get('iteration', 0) > 0:
            log(f"[Recovery] Found checkpoint from iteration {checkpoint_data.get('iteration')}")
            if cm.restore(agent, checkpoint_data):
                restored_from_checkpoint = True
                # Update task context for resumed work
                if checkpoint_data.get('context', {}).get('task'):
                    task_description = checkpoint_data['context']['task']
                log(f"[Recovery] ✓ Restored {len(agent.messages)} messages, continuing from iteration {agent.context.get('iteration')}")
                # Notify PM that we resumed
                notify_orchestrator('resumed', {
                    'ticket_id': TICKET_ID,
                    'resumed_from_iteration': agent.context.get('iteration'),
                    'message': f'Worker resumed from checkpoint (iteration {agent.context.get("iteration")})',
                })

        # ── Run the agent ─────────────────────────────────────────────────
        start_time = time_module.time()
        result = agent.run(initial_task=task_description)
        elapsed = time_module.time() - start_time

        log(f"Agent finished: result={result}, elapsed={elapsed:.1f}s")

        # ── Clear checkpoint on successful completion ─────────────────────
        if result == 'done':
            cm.clear()
            log("[Checkpoint] Cleared on task completion")

        # ── Handle result ─────────────────────────────────────────────────
        if result == 'done':
            log("✓ Task completed successfully")
            notify_orchestrator('completed', {
                'ticket_id': TICKET_ID,
                'summary': f'Task completed in {elapsed:.0f}s',
                'resumed_from_checkpoint': restored_from_checkpoint,
            })

        elif result == 'blocked':
            log("✗ Task is blocked, waiting for human intervention")
            backend.update_ticket_status(
                TICKET_ID, 'BLOCKED',
                'Task blocked — awaiting human intervention'
            )
            notify_orchestrator('blocked', {
                'ticket_id': TICKET_ID,
                'reason': 'Agent reported blocked state',
            })

        elif result == 'max_iterations':
            log("⚠ Max iterations reached without completion", 'WARN')
            backend.update_ticket_status(
                TICKET_ID, 'BLOCKED',
                f'Max iterations ({agent.max_iterations}) reached. Task may need human review.'
            )
            notify_orchestrator('blocked', {
                'ticket_id': TICKET_ID,
                'reason': f'Max iterations reached ({agent.max_iterations})',
            })

        else:
            log(f"Unknown result: {result}", 'WARN')

        # ── Interactive Mode — Bidirectional Admin Communication ───────────
        # After initial task, enter interactive mode to handle admin messages.
        # Uses orchestrator inbox polling (admin → Matrix room → orchestrator → inbox)
        # and orchestrator relay (worker → orchestrator → Matrix room → admin).
        if MATRIX_ROOM_ID:
            log("[Interactive] Entering bidirectional mode via orchestrator relay...")
            send_to_admin(f"👋 Hello! I'm the **{ROLE}** worker. Task finished ({result}). How can I help you?")

            # System prompt for interactive chat.
            # NOTE: run_interactive() automatically appends the available-tools
            # schema and the TOOL_CALL/ARGUMENTS format spec when this prompt
            # does not already contain "TOOL_CALL:", so the model knows how to
            # actually invoke tools (not just describe them in prose).
            chat_system = f"""You are a helpful AI assistant for the {ROLE} role.
You are chatting with a user (admin) via Matrix. Be conversational and helpful.
When the user asks you to do something that requires an action (reading/updating
tickets, searching or editing documentation, running terminal commands, etc.),
call the appropriate tool using the TOOL_CALL format described below — do NOT
just describe the command in prose. After the tool result comes back, write a
short, friendly natural-language answer summarising what you found or did.
You have access to Plane (tickets), BookStack (documentation), and terminal commands."""

            # ── Optional NATS subscriber (Phase 2 dual-read) ────────────────
            # When WORKER_NATS_SUBSCRIBE=true and nats-py is available, the
            # worker also drains an in-memory NATS inbox queue alongside the
            # HTTP poll. Messages are deduplicated by eventId across paths.
            from tools import nats_client
            nats_subscriber = nats_client.start_subscriber(TICKET_ID, ROLE)
            if nats_subscriber:
                log("[Interactive] NATS subscribe ACTIVE (dual-read)")
            seen_event_ids: set = set()

            def _ingest_message(msg: dict) -> bool:
                event_id = str(msg.get('eventId') or msg.get('event_id') or '')
                if event_id and event_id in seen_event_ids:
                    return False
                if event_id:
                    seen_event_ids.add(event_id)
                    if len(seen_event_ids) > 2048:
                        # Bounded set — drop arbitrary half.
                        for _victim in list(seen_event_ids)[:1024]:
                            seen_event_ids.discard(_victim)
                return True

            # Interactive loop: poll inbox → process → reply
            while True:
                admin_messages = list(poll_admin_inbox())
                if nats_subscriber:
                    admin_messages.extend(nats_subscriber.drain_inbox())
                for msg in admin_messages:
                    if not _ingest_message(msg):
                        continue
                    sender = msg.get('sender', 'admin')
                    content = msg.get('content', '')
                    is_command = msg.get('isStructuredCommand', False)
                    command_type = msg.get('commandType', '')
                    command_args = msg.get('commandArgs', {})

                    if not content.strip():
                        continue

                    log(f"[Interactive] {sender}: {content[:100]}...")

                    # ── Handle Structured Commands ────────────────────────────────
                    if is_command and command_type:
                        log(f"[Command] Executing: {command_type} with args={command_args}")
                        try:
                            from agent.command_executor import execute_worker_command
                            cmd_result = execute_worker_command(
                                agent=agent,
                                command_type=command_type,
                                command_args=command_args,
                                sender=sender,
                            )
                            send_to_admin(cmd_result)
                        except Exception as e:
                            log(f"[Command] Error: {e}")
                            send_to_admin(f"❌ Command execution failed: {str(e)[:200]}")
                        continue

                    # ── Regular Chat Message ─────────────────────────────────────
                    try:
                        # Create fresh agent for each message, respecting LLM_PROVIDER
                        # Reuse the same checkpoint manager so recovery state persists
                        chat_agent = create_agent(checkpoint_manager=cm)
                        chat_agent.system_prompt_override = chat_system

                        # Run interactive — get the response
                        result, response_content = chat_agent.run_interactive(content)

                        # Send reply back through orchestrator → Matrix
                        if response_content:
                            # Split long messages
                            if len(response_content) > 2000:
                                for i in range(0, len(response_content), 2000):
                                    send_to_admin(response_content[i:i+2000])
                            else:
                                send_to_admin(response_content)
                        else:
                            send_to_admin("✅ Done! Anything else?")

                    except Exception as e:
                        log(f"[Interactive] Error: {e}")
                        try:
                            send_to_admin(f"❌ Error: {str(e)[:200]}")
                        except Exception:
                            pass

                time_module.sleep(3)  # Poll every 3s

        log(f"Exiting (ticket: {TICKET_ID})")
        stop_health_monitor()
        sys.exit(0)

    except Exception as e:
        log(f"FATAL ERROR: {e}", 'ERROR')
        traceback.print_exc()

        # Try to mark ticket as blocked
        try:
            from tools import state_backend
            state_backend.get_backend().update_ticket_status(
                TICKET_ID, 'BLOCKED',
                f'Worker error: {str(e)[:500]}'
            )
            notify_orchestrator('blocked', {
                'ticket_id': TICKET_ID,
                'reason': f'Worker crash: {str(e)[:200]}',
            })
        except Exception:
            pass

        sys.exit(1)


if __name__ == "__main__":
    main()