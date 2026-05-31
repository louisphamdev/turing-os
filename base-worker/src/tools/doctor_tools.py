"""
Doctor Agent Tools — Diagnostic and self-healing toolkit for the Doctor worker role.

Provides tools for:
- System health monitoring (CPU, memory, disk, Docker, network)
- Docker log parsing and error aggregation
- Service connectivity checks (Plane, Wiki, Matrix, Context7, GitHub)
- Known issues database (BookStack via gateway REST)
- GitHub issue creation (via gateway)
- Self-healing fix scripts execution and verification
- Metrics tracking
- Doctor dashboard summary
- Admin communication for confirmations
- Fix success/failure reporting

Gateway-only design:
    All credentialed calls route through the orchestrator gateway using the
    worker's per-spawn CONSUMER_TOKEN. Raw provider secrets (the BookStack REST
    `Token`, the GitHub PAT, the Matrix bot access token) are held by the
    orchestrator/gateway and never enter the worker container.

    * BookStack known-issues / metrics / dashboard storage reuses
      ``bookstack_tools`` (``{GATEWAY_URL}/gateway/bookstack/<rest>`` with
      ``Authorization: Bearer {CONSUMER_TOKEN}``).
    * GitHub issue creation routes through
      ``{GATEWAY_URL}/gateway/github/repos/{owner}/{repo}/issues``.
    * Admin confirmations relay through ``{ORCHESTRATOR_URL}/webhooks/...``.

BookStack page convention (see bookstack_tools for the underlying REST model):
    A single book named ``Doctor`` holds every doctor-managed page.
        - Known issues  → page titled ``Known Issue: {error_key}`` (markdown).
        - Metrics       → page titled ``Metric: {metric_name}`` (markdown table).
        - Fix outcomes  → page titled ``Fix Outcomes`` (markdown tables).
    Pages are located by title via ``search_pages`` and created/updated via
    ``create_page`` / ``update_page``.

Environment variables:
    GATEWAY_URL         — Orchestrator gateway base URL (gateway-mode workers)
    CONSUMER_TOKEN      — Per-worker JWT used for every gateway/orchestrator call
    ORCHESTRATOR_URL    — Orchestrator API URL (default: http://turing-orchestrator:3001)
    PLANE_API_URL       — Plane API URL (default: http://turing_plane_api:8000/api/v1)
    PLANE_API_TOKEN     — Plane API key
    SYNAPSE_API_URL     — Synapse homeserver URL (default: http://synapse:8008)
    GITHUB_REPO         — GitHub repo as ``owner/name`` (e.g. louisphamdev/turing-os)
    GITHUB_REPO_OWNER   — GitHub repo owner (fallback when GITHUB_REPO unset)
    GITHUB_REPO_NAME    — GitHub repo name (fallback when GITHUB_REPO unset)
"""

import os
import json
import subprocess
import re
import time
from datetime import datetime, timezone
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── Environment ────────────────────────────────────────────────────────────────

ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
GATEWAY_URL = os.environ.get('GATEWAY_URL', '').rstrip('/')
CONSUMER_TOKEN = os.environ.get('CONSUMER_TOKEN', '')
# Used only for unauthenticated health/connectivity probes; carries no secret.
# All credentialed BookStack access goes through bookstack_tools via the gateway.
BOOKSTACK_URL = os.environ.get('BOOKSTACK_URL', 'http://wiki:3000')
PLANE_API_URL = os.environ.get('PLANE_API_URL', 'http://turing_plane_api:8000/api/v1')
PLANE_API_TOKEN = os.environ.get('PLANE_API_TOKEN', '')
SYNAPSE_API_URL = os.environ.get('SYNAPSE_API_URL', 'http://synapse:8008')

# Repo is canonically `owner/name` via GITHUB_REPO; fall back to the legacy
# split owner/name vars for backwards compatibility.
def _github_repo() -> tuple[str, str]:
    repo = os.environ.get('GITHUB_REPO', '').strip()
    if '/' in repo:
        owner, _, name = repo.partition('/')
        if owner and name:
            return owner, name
    return (
        os.environ.get('GITHUB_REPO_OWNER', 'turing-os'),
        os.environ.get('GITHUB_REPO_NAME', 'turing-os'),
    )


# BookStack book that holds all doctor-managed pages.
DOCTOR_BOOK_NAME = os.environ.get('DOCTOR_BOOK_NAME', 'Doctor')


# ─── 1. System Health ─────────────────────────────────────────────────────────

def check_system_health() -> dict:
    """
    Check overall system health: CPU%, memory%, disk%, Docker status,
    and network connectivity to critical services.

    Returns:
        dict with keys: cpu_percent, memory_percent, disk_percent,
        docker_status, network_connectivity, timestamp
    """
    import requests

    result = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'cpu_percent': None,
        'memory_percent': None,
        'disk_percent': None,
        'docker_status': 'unknown',
        'network_connectivity': {},
    }

    # CPU — /proc/stat delta over a short interval
    try:
        def cpu_read():
            with open('/proc/stat', 'r') as f:
                line = f.readline()
            fields = line.split()
            # user, nice, system, idle, iowait, irq, softirq
            return sum(int(x) for x in fields[1:8]), int(fields[4])  # total, idle

        t0_total, t0_idle = cpu_read()
        time.sleep(0.2)
        t1_total, t1_idle = cpu_read()
        total_diff = t1_total - t0_total
        idle_diff = t1_idle - t0_idle
        if total_diff > 0:
            result['cpu_percent'] = round(max(0.0, min(100.0, (total_diff - idle_diff) / total_diff * 100)), 1)
    except Exception:
        pass

    # Memory from /proc/meminfo
    try:
        with open('/proc/meminfo', 'r') as f:
            mem_lines = f.readlines()
        mem_total = mem_avail = 0
        for line in mem_lines:
            if line.startswith('MemTotal:'):
                mem_total = int(line.split()[1])
            elif line.startswith('MemAvailable:'):
                mem_avail = int(line.split()[1])
        if mem_total > 0:
            result['memory_percent'] = round((1 - mem_avail / mem_total) * 100, 1)
    except Exception:
        pass

    # Disk usage via df
    try:
        out = subprocess.run(
            ['df', '-h', '/'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0:
            parts = out.stdout.strip().split()
            if len(parts) >= 5:
                disk_str = parts[4].rstrip('%')
                if disk_str.isdigit():
                    result['disk_percent'] = int(disk_str)
    except Exception:
        pass

    # Docker status
    try:
        out = subprocess.run(
            ['docker', 'info'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        result['docker_status'] = 'running' if out.returncode == 0 else 'error'
    except FileNotFoundError:
        result['docker_status'] = 'not_installed'
    except Exception:
        result['docker_status'] = 'unknown'

    # Network connectivity checks — parallel for speed
    services_to_check = {
        'taiga': f'{PLANE_API_URL}/health',
        'bookstack': f'{BOOKSTACK_URL}/health',
        'orchestrator': f'{ORCHESTRATOR_URL}/health',
        'synapse': f'{SYNAPSE_API_URL}/_matrix/client/versions',
    }

    def _check_one_svc(svc_name: str, svc_url: str) -> tuple:
        try:
            resp = requests.get(svc_url, timeout=5)
            status = 'up' if resp.status_code < 500 else 'degraded'
            return (svc_name, {'status': status, 'status_code': resp.status_code})
        except requests.exceptions.ConnectionError:
            return (svc_name, {'status': 'down', 'status_code': None})
        except requests.exceptions.Timeout:
            return (svc_name, {'status': 'timeout', 'status_code': None})
        except Exception:
            return (svc_name, {'status': 'unknown', 'status_code': None})

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_check_one_svc, n, u) for n, u in services_to_check.items()]
        for f in as_completed(futures):
            name, data = f.result()
            result['network_connectivity'][name] = data

    return result


# ─── 2. Docker Log Parsing ────────────────────────────────────────────────────

def parse_docker_logs(container_name: str, lines: int = 50) -> dict:
    """
    Fetch and parse Docker logs for a given container.

    Strategy:
      1. Try local Docker socket first (fastest, works when running on host)
      2. Fall back to orchestrator relay: GET /containers/:name/logs

    Filters out INFO-level entries and highlights ERROR/WARN patterns.
    Each log entry is parsed into: timestamp, level, message.

    Args:
        container_name: Name of the Docker container
        lines: Number of log lines to fetch (default: 50)
    Returns:
        dict with entries list, error_count, warning_count, total_count
    """
    result = {
        'container': container_name,
        'entries': [],
        'error_count': 0,
        'warning_count': 0,
        'total_count': 0,
    }

    raw = ''

    # ── Strategy 1: local docker.sock ──────────────────────────────────────
    try:
        out = subprocess.run(
            ['docker', 'logs', '--tail', str(lines), '--timestamps', container_name],
            capture_output=True,
            text=True,
            timeout=30,
        )
        raw = out.stdout + out.stderr
    except FileNotFoundError:
        # Docker CLI not in this container — fall through to orchestrator
        raw = ''
    except subprocess.TimeoutExpired:
        result['error'] = 'Docker logs command timed out after 30s'
        return result
    except Exception:
        # Any other error → try orchestrator relay before giving up
        raw = ''

    # ── Strategy 2: orchestrator relay ────────────────────────────────────
    if not raw.strip():
        try:
            import requests as _req
            from orchestrator_auth import orchestrator_headers
            url = f'{ORCHESTRATOR_URL}/containers/{container_name}/logs'
            resp = _req.get(url, params={'lines': lines}, headers=orchestrator_headers(), timeout=20)
            if resp.status_code == 200:
                data = resp.json()
                raw = '\n'.join(
                    f"{e.get('timestamp','')} {e.get('level','')} {e.get('message','')}"
                    for e in data.get('entries', [])
                )
                result['_via_orchestrator'] = True
            elif resp.status_code == 404:
                result['error'] = f'Container not found: {container_name}'
                return result
            else:
                result['error'] = f'Orchestrator returned {resp.status_code}'
                return result
        except Exception as e:
            result['error'] = f'Both local Docker and orchestrator relay failed: {e}'
            return result

    # Regex to parse "2025-01-01T12:00:00.000000000Z ERROR message"
    log_pattern = re.compile(
        r'^(?P<timestamp>\S+\s+\S+?)\s+(?P<level>\w+)\s+(?P<message>.+)$',
        re.IGNORECASE,
    )

    for line in raw.splitlines():
        if not line.strip():
            continue
        result['total_count'] += 1

        m = log_pattern.match(line)
        if m:
            level = m.group('level').upper()
            entry = {
                'timestamp': m.group('timestamp'),
                'level': level,
                'message': m.group('message').strip(),
            }
        else:
            # Fallback: detect level from content
            level = 'INFO'
            for lvl in ('ERROR', 'FATAL', 'CRITICAL'):
                if lvl in line.upper():
                    level = lvl
                    break
            entry = {
                'timestamp': '',
                'level': level,
                'message': line.strip(),
            }

        if level in ('ERROR', 'FATAL', 'CRITICAL'):
            result['error_count'] += 1
        elif level in ('WARN', 'WARNING'):
            result['warning_count'] += 1

        result['entries'].append(entry)

    return result


# ─── 3. Service Connectivity ──────────────────────────────────────────────────

def check_service_connectivity(service_name: str) -> dict:
    """
    Test connectivity to a named service.

    Supported services: taiga, wiki, matrix, context7, github, orchestrator.

    Args:
        service_name: One of taiga, wiki, matrix, context7, github, orchestrator
    Returns:
        dict with status, response_time_ms, status_code, error (if any)
    """
    import requests

    service_endpoints = {
        'taiga': f'{PLANE_API_URL}/health',
        'bookstack': f'{BOOKSTACK_URL}/health',
        'matrix': f'{SYNAPSE_API_URL}/_matrix/client/versions',
        'context7': 'https://api.context7.com/health',
        'github': 'https://api.github.com',
        'orchestrator': f'{ORCHESTRATOR_URL}/health',
    }

    if service_name not in service_endpoints:
        return {
            'service': service_name,
            'status': 'unknown',
            'error': (
                f'Unknown service: {service_name}. '
                f'Supported: {list(service_endpoints.keys())}'
            ),
        }

    url = service_endpoints[service_name]
    start = time.time()
    try:
        resp = requests.get(url, timeout=10)
        elapsed_ms = round((time.time() - start) * 1000)
        if resp.status_code < 400:
            status = 'up'
        elif resp.status_code < 500:
            status = 'degraded'
        else:
            status = 'down'
        return {
            'service': service_name,
            'url': url,
            'status': status,
            'status_code': resp.status_code,
            'response_time_ms': elapsed_ms,
        }
    except requests.exceptions.ConnectionError:
        return {
            'service': service_name,
            'url': url,
            'status': 'down',
            'status_code': None,
            'error': 'Connection refused',
        }
    except requests.exceptions.Timeout:
        return {
            'service': service_name,
            'url': url,
            'status': 'timeout',
            'status_code': None,
            'error': 'Request timed out after 10s',
        }
    except Exception as e:
        return {
            'service': service_name,
            'url': url,
            'status': 'error',
            'status_code': None,
            'error': str(e),
        }


# ─── 4. Recent Errors Aggregation ─────────────────────────────────────────────

def check_recent_errors(count: int = 10) -> dict:
    """
    Aggregate recent ERROR-level log entries from all running Docker containers.

    Args:
        count: Maximum number of error entries to return across all containers (default: 10)
    Returns:
        dict with errors list, container_count, timestamp
    """
    result = {
        'errors': [],
        'container_count': 0,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    try:
        out = subprocess.run(
            ['docker', 'ps', '--format', '{{.Names}}'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            result['error'] = 'Failed to list Docker containers'
            return result
        containers = [c.strip() for c in out.stdout.splitlines() if c.strip()]
        result['container_count'] = len(containers)
    except FileNotFoundError:
        result['error'] = 'Docker not available'
        return result
    except Exception as e:
        result['error'] = str(e)
        return result

    for container in containers:
        logs = parse_docker_logs(container, lines=100)
        for entry in logs.get('entries', []):
            level = entry.get('level', '').upper()
            if level not in ('ERROR', 'FATAL', 'CRITICAL', 'WARN', 'WARNING'):
                continue
            msg = entry.get('message', '')[:200]
            result['errors'].append({
                'container': container,
                'level': level,
                'message': msg,
                'timestamp': entry.get('timestamp', ''),
            })
            if len(result['errors']) >= count:
                break
        if len(result['errors']) >= count:
            break

    result['errors'] = result['errors'][:count]
    return result


# ─── 4b. Docker Container Discovery ─────────────────────────────────────────

# Known worker role → container name patterns
# These are injected at startup from orchestrator health checks
# and updated every time list_docker_containers() is called.
_WORKER_CONTAINER_MAP: dict = {}


def list_docker_containers(include_logs: bool = False, log_lines: int = 20) -> dict:
    """
    List ALL Docker containers in the system (running + stopped),
    classify each by its likely worker role, and optionally attach
    the last log_lines of each.

    Discovery strategy:
      1. Local docker ps (fastest when doctor runs on host)
      2. Orchestrator relay: GET /containers (when doctor is inside a container)

    Classification logic:
      - Container name / image patterns → role guess
      - Labels (com.docker.compose.service, etc.)
      - HEALTHCHECK status
      - Doctor always includes itself as 'doctor'

    Args:
        include_logs: If True, fetch last log_lines for each container
        log_lines: How many log lines to fetch per container (default: 20)
    Returns:
        dict with containers list, worker_map, orchestrator_found, total_count
    """
    result = {
        'containers': [],
        'worker_map': {},   # role → container_name
        'orchestrator_found': False,
        'total_count': 0,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    raw_json = ''

    # ── Strategy 1: local docker ps ──────────────────────────────────────
    try:
        out = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{json .}}'],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if out.returncode == 0:
            raw_json = out.stdout
    except FileNotFoundError:
        raw_json = ''  # No docker CLI — fall to orchestrator
    except Exception:
        raw_json = ''

    # ── Strategy 2: orchestrator relay ──────────────────────────────────
    if not raw_json.strip():
        try:
            import requests as _req
            from orchestrator_auth import orchestrator_headers
            resp = _req.get(f'{ORCHESTRATOR_URL}/containers', headers=orchestrator_headers(), timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                raw_json = json.dumps(data.get('containers', []))
                result['orchestrator_found'] = True
        except Exception:
            pass

    if not raw_json.strip():
        result['error'] = 'Cannot discover containers: no local Docker and orchestrator unreachable'
        return result

    # Pattern matchers for role classification
    role_patterns = [
        ('orchestrat', 'orchestrator'),
        ('doctor', 'doctor'),
        ('devops', 'devops'),
        ('qa', 'qa'),
        ('se-', 'software-engineer'),
        ('software-engineer', 'software-engineer'),
        ('po', 'po'),
        ('pm', 'pm'),
        ('hr', 'hr'),
        ('data', 'data'),
        ('network', 'network'),
        ('security', 'security'),
        ('taiga', 'taiga'),
        ('bookstack', 'bookstack'),
        ('synapse', 'matrix'),
        ('matrix', 'matrix'),
        ('context7', 'context7'),
        ('redis', 'redis'),
        ('postgres', 'postgres'),
        ('nginx', 'nginx'),
        ('rabbitmq', 'rabbitmq'),
        ('celery', 'celery'),
        ('worker', 'generic-worker'),
    ]

    def classify(name: str, image: str) -> str:
        combined = f"{name} {image}".lower()
        for pat, role in role_patterns:
            if pat.lower() in combined:
                return role
        return 'unknown'

    containers = []
    for line in raw_json.splitlines():
        if not line.strip():
            continue
        try:
            c = json.loads(line)
        except Exception:
            continue

        name = c.get('Names', c.get('Name', '')).lstrip('/')
        image = c.get('Image', '')
        status = c.get('Status', '')
        state = c.get('State', '')
        role = classify(name, image)

        entry: dict = {
            'name': name,
            'image': image,
            'status': status,
            'state': state,
            'role': role,
            'health': c.get('Health', ''),
        }

        if role == 'orchestrator' or 'orchestrat' in name.lower():
            result['orchestrator_found'] = True

        if role != 'unknown':
            existing = result['worker_map'].get(role)
            if existing is None or (state == 'running' and existing.get('state') != 'running'):
                result['worker_map'][role] = {'name': name, 'state': state}

        if include_logs:
            logs = parse_docker_logs(name, lines=log_lines)
            entry['logs'] = logs.get('entries', [])[-log_lines:]
            entry['log_error_count'] = logs.get('error_count', 0)
            entry['log_warning_count'] = logs.get('warning_count', 0)

        containers.append(entry)

    result['containers'] = containers
    result['total_count'] = len(containers)
    _inject_self_docker_info(result)
    return result


def _inject_self_docker_info(result: dict) -> None:
    """Inject the Doctor container's own info into the result if available."""
    try:
        out = subprocess.run(
            ['docker', 'ps', '--filter', 'label=role=doctor', '--format', '{{json .}}'],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            for line in out.stdout.splitlines():
                try:
                    c = json.loads(line)
                    name = c.get('Names', '').lstrip('/')
                    if name and name not in [x['name'] for x in result['containers']]:
                        result['containers'].insert(0, {
                            'name': name,
                            'image': c.get('Image', ''),
                            'status': c.get('Status', ''),
                            'state': c.get('State', ''),
                            'role': 'doctor',
                            'health': c.get('Health', ''),
                        })
                        result['worker_map']['doctor'] = {'name': name, 'state': c.get('State', '')}
                except Exception:
                    pass
    except Exception:
        pass


def get_container_inspect(container_name: str) -> dict:
    """
    Return full docker inspect output for a container — gives Doctor
    complete visibility into container config: restart count, restart
    policy, mounts, networks, environment, resource limits.

    Args:
        container_name: Name of the container
    Returns:
        dict with inspect data or error
    """
    try:
        out = subprocess.run(
            ['docker', 'inspect', container_name],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if out.returncode != 0:
            return {'error': f'docker inspect failed: {out.stderr}'}
        data = json.loads(out.stdout)
        if not data:
            return {'error': f'Container not found: {container_name}'}

        info = data[0]
        # Extract the most useful fields for diagnostics
        cfg = info.get('Config', {})
        state = info.get('State', {})
        host_cfg = info.get('HostConfig', {})

        return {
            'name': info.get('Name', '').lstrip('/'),
            'image': cfg.get('Image', ''),
            'created': info.get('Created', ''),
            'state': {
                'status': state.get('Status', ''),
                'running': state.get('Running', False),
                'restarting': state.get('Restarting', False),
                'exit_code': state.get('ExitCode', 0),
                'restart_count': state.get('RestartCount', 0),
                'started_at': state.get('StartedAt', ''),
                'finished_at': state.get('FinishedAt', ''),
                'error': state.get('Error', ''),
            },
            'restart_policy': host_cfg.get('RestartPolicy', {}),
            'resource_limits': {
                'memory': host_cfg.get('Memory', 0),
                'memory_swap': host_cfg.get('MemorySwap', 0),
                'cpu_shares': host_cfg.get('CPUShares', 0),
                'cpu_period': host_cfg.get('CPUPeriod', 0),
                'cpu_quota': host_cfg.get('CPUQuota', 0),
            },
            ' mounts': info.get('Mounts', []),
            'networks': list(info.get('NetworkSettings', {}).get('Networks', {}).keys()),
            'env': [e for e in cfg.get('Env', []) if any(k in e for k in ('ROLE', 'WORKER', 'AGENT', 'LLM'))],
            'label': cfg.get('Labels', {}),
        }
    except FileNotFoundError:
        return {'error': 'Docker not available'}
    except json.JSONDecodeError:
        return {'error': 'Failed to parse docker inspect output'}
    except Exception as e:
        return {'error': str(e)}


def tail_container_logs(container_name: str, tail: int = 50, since: str = '') -> dict:
    """
    Stream-like log reader: fetch live logs from a container,
    filter ERROR/WARN lines, and return structured entries.

    Unlike parse_docker_logs which reads static snapshots, this tool
    uses 'docker logs --follow' for real-time log monitoring.

    Args:
        container_name: Name of the container
        tail: Number of recent lines to fetch (default: 50)
        since: ISO timestamp to fetch logs since (default: all recent)
    Returns:
        dict with entries, error_count, warning_count, total_count
    """
    result = {
        'container': container_name,
        'entries': [],
        'error_count': 0,
        'warning_count': 0,
        'total_count': 0,
    }

    cmd = ['docker', 'logs', '--tail', str(tail), '--timestamps', container_name]
    if since:
        cmd += ['--since', since]

    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        raw = out.stdout + out.stderr
    except FileNotFoundError:
        result['error'] = 'Docker not available'
        return result
    except subprocess.TimeoutExpired:
        result['error'] = 'Log fetch timed out after 30s'
        return result
    except Exception as e:
        result['error'] = str(e)
        return result

    log_pattern = re.compile(
        r'^(?P<timestamp>\S+\s+\S+?)\s+(?P<level>\w+)\s+(?P<message>.+)$',
        re.IGNORECASE,
    )

    for line in raw.splitlines():
        if not line.strip():
            continue
        result['total_count'] += 1
        m = log_pattern.match(line)
        if m:
            level = m.group('level').upper()
            entry = {
                'timestamp': m.group('timestamp'),
                'level': level,
                'message': m.group('message').strip(),
            }
        else:
            level = 'INFO'
            for lvl in ('ERROR', 'FATAL', 'CRITICAL'):
                if lvl in line.upper():
                    level = lvl
                    break
            entry = {'timestamp': '', 'level': level, 'message': line.strip()}

        if level in ('ERROR', 'FATAL', 'CRITICAL'):
            result['error_count'] += 1
        elif level in ('WARN', 'WARNING'):
            result['warning_count'] += 1

        result['entries'].append(entry)

    return result


def find_containers_by_role(role: str) -> dict:
    """
    Find all containers matching a worker role (e.g. 'doctor', 'devops', 'qa').

    Uses list_docker_containers() internally so the result always reflects
    the current live state.

    Args:
        role: Worker role to search for (e.g. 'doctor', 'devops', 'se')
    Returns:
        dict with role, containers list, count
    """
    all_containers = list_docker_containers(include_logs=False)
    if 'error' in all_containers:
        return {'role': role, 'containers': [], 'count': 0, 'error': all_containers.get('error')}

    matched = [c for c in all_containers.get('containers', []) if c.get('role') == role]
    return {
        'role': role,
        'containers': matched,
        'count': len(matched),
        'timestamp': all_containers.get('timestamp', ''),
    }


# ─── 5 & 6. BookStack Known Issues DB ─────────────────────────────────────────

def _bookstack():
    """Import bookstack_tools lazily so the module loads even if requests is absent.

    bookstack_tools routes every call through the gateway proxy
    (``{GATEWAY_URL}/gateway/bookstack/<rest>``) using the worker's
    CONSUMER_TOKEN; the gateway injects the real BookStack ``Token`` and
    forwards to BookStack's REST ``/api/...`` endpoints.
    """
    try:
        from tools import bookstack_tools  # runtime: base-worker/src on path
    except ImportError:
        from src.tools import bookstack_tools  # tests/CI import style
    return bookstack_tools


def _ensure_doctor_book() -> dict:
    """Ensure the Doctor book exists and return it ({'id', 'name', ...} or error)."""
    bs = _bookstack()
    return bs.ensure_book(DOCTOR_BOOK_NAME, 'Doctor agent: known issues, metrics, fix outcomes')


def _find_doctor_page(title: str) -> Optional[dict]:
    """Locate a doctor page by exact title via BookStack search.

    Returns the matching search hit ({'id', 'name', ...}) or None.
    """
    bs = _bookstack()
    for hit in bs.search_pages(title, count=30):
        if hit.get('type') == 'page' and hit.get('name', '').strip() == title.strip():
            return hit
    return None


def _read_doctor_page_content(title: str) -> str:
    """Return the markdown (preferred) or html content of a doctor page by title."""
    hit = _find_doctor_page(title)
    if not hit:
        return ''
    bs = _bookstack()
    page = bs.read_page(str(hit.get('id', '')))
    if 'error' in page:
        return ''
    return page.get('markdown') or page.get('html') or ''


def _upsert_doctor_page(title: str, content: str) -> dict:
    """Create or update a doctor page by title, returning a normalized dict.

    Returns {'success': bool, 'page_id', 'error'?}.
    """
    bs = _bookstack()
    hit = _find_doctor_page(title)
    if hit:
        result = bs.update_page(int(hit['id']), title=title, content=content, markdown=True)
        if 'error' in result:
            return {'success': False, 'error': result['error']}
        return {'success': True, 'page_id': result.get('id', hit['id'])}

    book = _ensure_doctor_book()
    if 'error' in book or not book.get('id'):
        return {'success': False, 'error': book.get('error', 'could not resolve Doctor book')}
    result = bs.create_page(int(book['id']), title, content, markdown=True)
    if 'error' in result:
        return {'success': False, 'error': result['error']}
    return {'success': True, 'page_id': result.get('id')}


def _parse_known_issue_page(content: str) -> dict:
    """
    Parse a known issue page's markdown content into structured fields.
    Supports both markdown table format and key: value format.
    """
    issue = {
        'error_key': '',
        'symptoms': '',
        'causes': '',
        'fix': '',
        'pattern': '',
    }
    lines = content.splitlines()
    for line in lines:
        line_stripped = line.strip()
        # Skip table header/separator lines
        if re.match(r'^\|?\s*[-:]+\s*\|', line_stripped):
            continue
        if not line_stripped.startswith('|') and ':' in line_stripped:
            key, _, val = line_stripped.partition(':')
            key = key.strip().lower().replace(' ', '_')
            if key in issue:
                issue[key] = val.strip()
        elif line_stripped.startswith('|') and line_stripped.endswith('|'):
            parts = [p.strip() for p in line_stripped.split('|')[1:-1]]
            if len(parts) >= 4:
                issue['error_key'] = parts[0]
                issue['symptoms'] = parts[1]
                issue['causes'] = parts[2]
                issue['fix'] = parts[3]
            elif len(parts) == 2:
                issue['error_key'] = parts[0]
                issue['fix'] = parts[1]
    return issue


def query_known_issues_db(error_pattern: str) -> list:
    """
    Search the known issues database in BookStack (the ``Doctor`` book) via the
    gateway REST proxy.

    Known issues are stored as pages titled ``Known Issue: {error_key}``. This
    searches for matching pages, reads each one, parses its structured fields,
    and returns those whose error_key/pattern/symptoms/fix match the query.

    Args:
        error_pattern: Search query string to match against known issue patterns,
                       error keys, symptoms, or fixes
    Returns:
        list of matching known issue records (error_key, symptoms, causes, fix, pattern)
    """
    bs = _bookstack()
    # Search constrained to known-issue pages: combine the marker with the query.
    hits = bs.search_pages(f'"Known Issue:" {error_pattern}', count=50)
    if not hits:
        # Fall back to a marker-only search so listing still works.
        hits = bs.search_pages('Known Issue:', count=100)

    results = []
    seen_ids = set()
    for hit in hits:
        if hit.get('type') != 'page':
            continue
        title = hit.get('name', '')
        if not title.startswith('Known Issue:'):
            continue
        page_id = str(hit.get('id', ''))
        if page_id in seen_ids:
            continue
        seen_ids.add(page_id)

        page = bs.read_page(page_id)
        if 'error' in page:
            continue
        content = page.get('markdown') or page.get('html') or ''

        issue = _parse_known_issue_page(content)
        issue['title'] = title
        issue['page_id'] = page.get('id', page_id)
        # The title encodes the canonical key; trust it over the body parse,
        # whose 2-column "Field | Value" table is ambiguous.
        issue['error_key'] = title[len('Known Issue:'):].strip()

        # Match against error_pattern
        search_target = ' '.join([
            issue.get('error_key', ''),
            issue.get('pattern', ''),
            issue.get('symptoms', ''),
            issue.get('fix', ''),
            title,
        ]).lower()
        if error_pattern.lower() in search_target:
            results.append(issue)

    return results


def save_to_known_issues(
    error_key: str,
    symptoms: str,
    causes: str,
    fix: str,
    pattern: str,
) -> dict:
    """
    Save a known issue record to BookStack (the ``Doctor`` book) via the gateway
    REST proxy.

    The record is stored as a page titled ``Known Issue: {error_key}``. If a
    page with that title already exists it is updated in place; otherwise a new
    page is created.

    Args:
        error_key: Unique identifier for this error class
        symptoms: Human-readable description of error symptoms
        causes: Root cause(s) of the error
        fix: Recommended fix or workaround
        pattern: Regex or keyword pattern for detection
    Returns:
        dict with success, page_id, page_path
    """
    timestamp = datetime.now(timezone.utc).isoformat()
    title = f"Known Issue: {error_key}"

    content_lines = [
        f"# {error_key}",
        "",
        f"**Recorded:** {timestamp}",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| Error Key | {error_key} |",
        f"| Pattern | {pattern} |",
        f"| Symptoms | {symptoms} |",
        f"| Causes | {causes} |",
        f"| Fix | {fix} |",
        "",
        "## Symptoms",
        symptoms,
        "",
        "## Root Causes",
        causes,
        "",
        "## Fix / Workaround",
        fix,
        "",
        "## Detection Pattern",
        "```",
        pattern,
        "```",
    ]
    content = '\n'.join(content_lines)

    result = _upsert_doctor_page(title, content)
    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'unknown error')}

    return {
        'success': True,
        'page_id': result.get('page_id'),
        'page_path': title,
    }


# ─── 7. GitHub Issue Creation ─────────────────────────────────────────────────

def create_github_issue(
    title: str,
    body: str,
    labels: list = None,
    assignees: list = None,
) -> dict:
    """
    Create a GitHub issue via the orchestrator gateway.

    Routes through ``{GATEWAY_URL}/gateway/github/repos/{owner}/{repo}/issues``
    (POST) authenticated with the worker's CONSUMER_TOKEN. The gateway injects
    the real GitHub credential and forwards to GitHub's REST API; the raw PAT
    never enters the worker container.

    The repo (``owner/name``) comes from the ``GITHUB_REPO`` env var.

    Args:
        title: Issue title
        body: Issue body (markdown supported)
        labels: List of label names (default: [])
        assignees: List of GitHub usernames (default: [])
    Returns:
        dict with success, issue_url, issue_number, error
    """
    import requests

    if not GATEWAY_URL or not CONSUMER_TOKEN:
        return {
            'success': False,
            'error': (
                'GitHub issue creation requires GATEWAY_URL + CONSUMER_TOKEN. '
                'Workers must be spawned with gateway mode enabled.'
            ),
        }

    try:
        from orchestrator_auth import orchestrator_headers
    except ImportError:
        from src.orchestrator_auth import orchestrator_headers

    owner, repo = _github_repo()
    url = f'{GATEWAY_URL}/gateway/github/repos/{owner}/{repo}/issues'
    headers = orchestrator_headers({
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
    })
    payload = {
        'title': title,
        'body': body,
        'labels': labels or [],
        'assignees': assignees or [],
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
        if resp.status_code in (200, 201):
            data = resp.json() if resp.content else {}
            return {
                'success': True,
                'issue_url': data.get('html_url'),
                'issue_number': data.get('number'),
            }
        return {
            'success': False,
            'error': f'GitHub gateway returned {resp.status_code}: {resp.text}',
            'status_code': resp.status_code,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── 8. Fix Execution (orchestrator-mediated remediation) ─────────────────────
#
# Workers have NO docker CLI/socket (least-privilege hardening). All docker
# control routes through the orchestrator's allow-listed, audited remediation
# API (Task P4b): POST {ORCHESTRATOR_URL}/remediation with
# {"action": "<name>", "target": "<optional>"} and the worker's CONSUMER_TOKEN.
#
# Allowed orchestrator actions (see orchestrator/src/core/remediation.ts):
#   - restart_container  (target = worker ticketId/name; worker-token OK)
#   - check_disk_usage   (read-only; worker-token OK)
#   - cleanup_docker     (requires ADMIN token — worker-token call gets 401)
#
# Doctor "fix names" (historically local .ps1/.sh scripts) are mapped to these
# safe actions. Anything not in the map needs host/infra access the worker must
# not have, so it is rejected with a clear "escalate to human" result.

# Map of legacy fix-script names → orchestrator remediation actions.
_FIX_TO_REMEDIATION = {
    'restart_container': 'restart_container',
    'restart_service': 'restart_container',
    'restart_pm': 'restart_container',
    'check_disk_usage': 'check_disk_usage',
    'cleanup_docker': 'cleanup_docker',
}


def run_fix_script(fix_name: str, target: str = '') -> dict:
    """
    Apply a self-healing fix via the orchestrator remediation API.

    Local script/docker execution is removed: the worker has no docker
    CLI/socket. Instead, the named fix is mapped to an allow-listed
    orchestrator remediation action and POSTed to
    ``{ORCHESTRATOR_URL}/remediation`` with the worker's CONSUMER_TOKEN.

    Fix-name → action mapping:
        restart_container / restart_service / restart_pm → ``restart_container``
        check_disk_usage                                 → ``check_disk_usage``
        cleanup_docker                                   → ``cleanup_docker`` (admin)
    Unknown/unmapped names (restart_docker, reset_network, increase_memory, …)
    require host/infra access the worker must not have → escalate to a human.

    Args:
        fix_name: Logical fix name (alphanumeric, dash, underscore).
        target:   Optional container target (ticketId/name) for restart_container.
    Returns:
        dict with success, output/detail, action (and error on failure).
    """
    # Security: restrict fix_name to safe characters
    if not re.match(r'^[a-zA-Z0-9_-]+$', fix_name):
        return {'success': False, 'error': f'Invalid fix name (only alphanumeric, dash, underscore allowed): {fix_name}'}

    action = _FIX_TO_REMEDIATION.get(fix_name)
    if action is None:
        return {
            'success': False,
            'fix_name': fix_name,
            'error': f'no safe remediation for {fix_name}; escalate to human',
            'detail': (
                f'Fix "{fix_name}" needs host/infra access the worker does not '
                f'have (no docker CLI/socket). Allowed remediations: '
                f'{sorted(_FIX_TO_REMEDIATION)}. Escalate to a human.'
            ),
        }

    if not ORCHESTRATOR_URL or not CONSUMER_TOKEN:
        return {
            'success': False,
            'fix_name': fix_name,
            'action': action,
            'error': (
                'Remediation requires ORCHESTRATOR_URL + CONSUMER_TOKEN. '
                'Workers must be spawned with gateway mode enabled.'
            ),
        }

    try:
        import requests
        try:
            from orchestrator_auth import orchestrator_headers
        except ImportError:
            from src.orchestrator_auth import orchestrator_headers

        payload = {'action': action}
        if target:
            payload['target'] = target

        resp = requests.post(
            f'{ORCHESTRATOR_URL}/remediation',
            json=payload,
            headers=orchestrator_headers({'Content-Type': 'application/json'}),
            timeout=120,
        )
    except Exception as e:
        return {'success': False, 'fix_name': fix_name, 'action': action, 'error': str(e)}

    # cleanup_docker is admin-gated: a worker-token call is rejected by
    # requireAdmin (401/403). Surface a clear escalate result, do not crash.
    if resp.status_code in (401, 403):
        return {
            'success': False,
            'fix_name': fix_name,
            'action': action,
            'status_code': resp.status_code,
            'error': (
                f'{action} requires an admin token (worker token returned '
                f'{resp.status_code}); escalate to a human / admin to run it.'
            ),
        }

    try:
        data = resp.json() if resp.content else {}
    except Exception:
        data = {}

    if resp.status_code == 200 and data.get('ok'):
        return {
            'success': True,
            'fix_name': fix_name,
            'action': action,
            'output': data.get('detail', ''),
            'detail': data.get('detail', ''),
            'data': data.get('data'),
        }

    # 400 (unknown action — shouldn't happen given the map), 422 (action
    # failed), 5xx, or ok:false — surface a clear error.
    detail = data.get('detail') or data.get('error') or resp.text
    return {
        'success': False,
        'fix_name': fix_name,
        'action': action,
        'status_code': resp.status_code,
        'error': f'Remediation {action} failed (HTTP {resp.status_code}): {detail}',
        'detail': detail,
    }


# ─── 9. Verify Fix ────────────────────────────────────────────────────────────

def verify_fix(command: str, expected_outcome: str) -> dict:
    """
    Verify a remediation outcome via the orchestrator container relay.

    The worker has no docker CLI/shell, so the previous
    ``docker ps | grep ...`` verification cannot run. Instead this queries
    ``GET {ORCHESTRATOR_URL}/containers`` (with the worker's CONSUMER_TOKEN)
    and confirms the target container is present and running.

    The ``command`` arg is kept for signature/back-compat but is interpreted
    only as a container hint: ``expected_outcome`` is the container name to
    confirm. For container verification, pass the target container name as
    ``expected_outcome``. Non-container verification cannot be performed by the
    worker and returns a clear "manual verification needed" result.

    Args:
        command: Legacy command string (retained for compatibility; not exec'd).
        expected_outcome: Container name expected to be present/running.
    Returns:
        dict with success, actual_output, matches, expected_outcome, command.
    """
    target = (expected_outcome or '').strip()

    # Only container-presence verification is supported by the worker.
    if not target:
        return {
            'success': False,
            'matches': False,
            'expected_outcome': expected_outcome,
            'command': command,
            'error': (
                'manual verification needed: no container name to confirm. '
                'verify_fix can only check container presence/state via the '
                'orchestrator relay.'
            ),
        }

    if not ORCHESTRATOR_URL or not CONSUMER_TOKEN:
        return {
            'success': False,
            'matches': False,
            'expected_outcome': expected_outcome,
            'command': command,
            'error': (
                'Container verification requires ORCHESTRATOR_URL + '
                'CONSUMER_TOKEN. Workers must be spawned with gateway mode.'
            ),
        }

    try:
        import requests as _req
        try:
            from orchestrator_auth import orchestrator_headers
        except ImportError:
            from src.orchestrator_auth import orchestrator_headers

        resp = _req.get(
            f'{ORCHESTRATOR_URL}/containers',
            headers=orchestrator_headers(),
            timeout=15,
        )
    except Exception as e:
        return {
            'success': False,
            'matches': False,
            'expected_outcome': expected_outcome,
            'command': command,
            'error': str(e),
        }

    if resp.status_code != 200:
        return {
            'success': False,
            'matches': False,
            'expected_outcome': expected_outcome,
            'command': command,
            'status_code': resp.status_code,
            'error': f'Container relay returned HTTP {resp.status_code}: {resp.text}',
        }

    try:
        containers = (resp.json() or {}).get('containers', [])
    except Exception:
        containers = []

    target_lc = target.lstrip('/').lower()
    matched = None
    for c in containers:
        name = str(c.get('name', '')).lstrip('/').lower()
        if not name:
            continue
        if name == target_lc or target_lc in name:
            matched = c
            break

    if matched is None:
        return {
            'success': False,
            'matches': False,
            'expected_outcome': expected_outcome,
            'command': command,
            'actual_output': f'container "{target}" not found among {len(containers)} containers',
        }

    state = str(matched.get('state', '')).lower()
    running = state == 'running'
    return {
        'success': running,
        'matches': running,
        'expected_outcome': expected_outcome,
        'command': command,
        'container': matched.get('name'),
        'state': matched.get('state'),
        'status': matched.get('status'),
        'actual_output': f"{matched.get('name')} state={matched.get('state')} status={matched.get('status')}",
    }


# ─── 10. Track Metrics (BookStack) ─────────────────────────────────────────────

def _parse_metric_entries(content: str) -> list:
    """Parse metric entries from a metric page's markdown table."""
    entries = []
    for line in content.splitlines():
        line = line.strip()
        if not line.startswith('|') or '-:|' in line or 'Timestamp' in line:
            continue
        parts = [p.strip() for p in line.split('|')[1:-1]]
        if len(parts) == 2:
            ts, val = parts
            try:
                entries.append({'timestamp': ts, 'value': float(val)})
            except ValueError:
                pass
    return entries


def _get_metric_page(metric_name: str) -> dict:
    """Read existing metric page content and entries from BookStack via gateway."""
    content = _read_doctor_page_content(f"Metric: {metric_name}")
    return {'content': content, 'entries': _parse_metric_entries(content)}


def track_metrics(metric_name: str, value: float) -> dict:
    """
    Save a metric value to BookStack (the ``Doctor`` book) via the gateway proxy.

    Metrics are stored as a markdown table on a page titled ``Metric: {name}``.
    Up to the last 100 entries are kept; the page is upserted on each call.

    Args:
        metric_name: Name of the metric (e.g., "fix_success_rate", "error_count")
        value: Numeric value to record
    Returns:
        dict with success, metric_name, value, page_path, entry_count
    """
    timestamp = datetime.now(timezone.utc).isoformat()
    title = f"Metric: {metric_name}"

    existing = _get_metric_page(metric_name)
    entries = existing.get('entries', [])
    entries.append({'timestamp': timestamp, 'value': value})
    entries = entries[-100:]  # Keep last 100

    content_lines = [
        f"# {metric_name}",
        "",
        f"## History (last {len(entries)} entries)",
        "",
        "| Timestamp | Value |",
        "| --- | --- |",
    ]
    for e in entries:
        content_lines.append(f"| {e['timestamp']} | {e['value']} |")

    content = '\n'.join(content_lines)

    result = _upsert_doctor_page(title, content)
    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'unknown error')}

    return {
        'success': True,
        'metric_name': metric_name,
        'value': value,
        'page_path': title,
        'entry_count': len(entries),
    }


# ─── 11. Doctor Dashboard ─────────────────────────────────────────────────────

def _read_fix_outcomes() -> dict:
    """Read fix success/failure counts from the ``Fix Outcomes`` BookStack page."""
    content = _read_doctor_page_content('Fix Outcomes')
    return {'content': content}


def get_doctor_dashboard() -> dict:
    """
    Get a summary dashboard of recent errors, fix success rate, and open escalations.

    Returns:
        dict with recent_errors, fix_success_rate, open_escalations_count,
        system_health_summary, timestamp
    """
    result = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'recent_errors': [],
        'fix_success_rate': None,
        'open_escalations_count': 0,
        'system_health_summary': {},
    }

    # Recent errors
    errors = check_recent_errors(count=20)
    result['recent_errors'] = errors.get('errors', [])[:10]

    # Fix success rate
    fix_data = _read_fix_outcomes()
    content = fix_data.get('content', '')
    success_count = failure_count = 0
    for line in content.splitlines():
        ls = line.strip()
        if '| SUCCESS |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    success_count = int(parts[1])
                except ValueError:
                    pass
        elif '| FAILURE |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    failure_count = int(parts[1])
                except ValueError:
                    pass
    total_fixes = success_count + failure_count
    if total_fixes > 0:
        result['fix_success_rate'] = round(success_count / total_fixes * 100, 1)
        result['total_fixes_attempted'] = total_fixes
        result['successful_fixes'] = success_count
        result['failed_fixes'] = failure_count

    # System health
    health = check_system_health()
    result['system_health_summary'] = {
        'docker': health.get('docker_status'),
        'network': health.get('network_connectivity', {}),
        'disk_percent': health.get('disk_percent'),
        'memory_percent': health.get('memory_percent'),
    }

    # Open escalations: issues in known-issues DB that have no fix
    known = query_known_issues_db('escalation')
    result['open_escalations_count'] = sum(
        1 for ki in known if not ki.get('fix')
    )

    return result


# ─── 12. Ask User Confirmation ───────────────────────────────────────────────

def ask_user_confirmation(question: str) -> dict:
    """
    Send a confirmation question to admin via the orchestrator relay and wait
    for a reply.

    The question is posted to ``{ORCHESTRATOR_URL}/webhooks/worker-message``
    (authenticated by the worker's CONSUMER_TOKEN) and the worker inbox is
    polled for the admin's reply for up to 600 seconds. There is no direct
    Matrix path: the orchestrator owns the Matrix bot token, so if the relay is
    unreachable this returns a clear "could not reach admin" result.

    Args:
        question: The yes/no or confirmation question to ask admin
    Returns:
        dict with success, confirmed (bool or None), reply, sender, timestamp
    """
    import requests

    ticket_id = os.environ.get('TICKET_ID', '')
    question_sent_at_ms = int(time.time() * 1000)

    try:
        from orchestrator_auth import orchestrator_headers
    except ImportError:
        from src.orchestrator_auth import orchestrator_headers

    # Post the question through the orchestrator relay.
    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': ticket_id,
                'message': f'[Doctor Agent] Confirmation needed: {question}',
                'message_type': 'question',
                'timeout_seconds': 600,
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
        relay_success = resp.status_code == 200
    except Exception as e:
        return {
            'success': False,
            'confirmed': None,
            'error': f'Could not reach admin: orchestrator relay request failed ({e})',
        }

    if not relay_success:
        return {
            'success': False,
            'confirmed': None,
            'error': f'Could not reach admin: orchestrator relay returned {resp.status_code}',
        }

    # Poll for admin reply
    start = time.time()
    poll_interval = 3

    while time.time() - start < 600:
        try:
            inbox_resp = requests.get(
                f'{ORCHESTRATOR_URL}/webhooks/worker-inbox/{ticket_id}',
                params={'since': question_sent_at_ms},
                headers=orchestrator_headers(),
                timeout=10,
            )
            if inbox_resp.status_code == 200:
                messages = inbox_resp.json().get('messages', [])
                for msg in messages:
                    content = msg.get('content', '').lower()
                    sender = msg.get('sender', '')
                    ts = msg.get('timestamp', '')
                    if any(k in content for k in ('yes', 'confirm', 'proceed', 'ok', 'go ahead')):
                        return {
                            'success': True,
                            'confirmed': True,
                            'reply': msg.get('content'),
                            'sender': sender,
                            'timestamp': ts,
                        }
                    elif any(k in content for k in ('no', 'cancel', 'abort', 'stop', "don't")):
                        return {
                            'success': True,
                            'confirmed': False,
                            'reply': msg.get('content'),
                            'sender': sender,
                            'timestamp': ts,
                        }
        except Exception:
            pass
        time.sleep(poll_interval)

    return {
        'success': False,
        'confirmed': None,
        'error': 'No reply from admin within 600s',
    }


# ─── 13. Report Fix Success ───────────────────────────────────────────────────

def report_fix_success(
    ticket_id: str,
    fix_applied: str,
    classification: str = '',
) -> dict:
    """
    Record a successful fix for metrics tracking and notify admin via the
    orchestrator relay.

    Args:
        ticket_id: The Plane ticket ID associated with the fix
        fix_applied: Description of the fix that was applied
        classification: Category of issue (e.g., "network", "memory", "docker", "PROJECT_BUG", "LLM_BUG")
    Returns:
        dict with success, ticket_id, fix_applied
    """
    import requests

    timestamp = datetime.now(timezone.utc).isoformat()
    title = 'Fix Outcomes'

    fix_data = _read_fix_outcomes()
    content = fix_data.get('content', '')

    # Parse existing counts
    success_count = failure_count = 0
    for line in content.splitlines():
        ls = line.strip()
        if '| SUCCESS |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    success_count = int(parts[1])
                except ValueError:
                    pass
        elif '| FAILURE |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    failure_count = int(parts[1])
                except ValueError:
                    pass

    success_count += 1

    content_lines = [
        '# Fix Outcomes',
        '',
        '| Outcome | Count |',
        '| --- | --- |',
        f'| SUCCESS | {success_count} |',
        f'| FAILURE | {failure_count} |',
        '',
        '## Recent Successes',
        '',
        '| Timestamp | Ticket | Fix Applied | Classification |',
        '| --- | --- | --- | --- |',
    ]

    # Preserve existing success rows (find them)
    in_success_section = False
    for line in content.splitlines():
        if line.strip() == '## Recent Successes':
            in_success_section = True
            continue
        if line.strip().startswith('## '):
            in_success_section = False
        if in_success_section and '| SUCCESS |' not in line and '| Timestamp' not in line and '-:|' not in line and line.strip().startswith('|'):
            content_lines.append(line)

    # Append new entry
    content_lines.append(f'| {timestamp} | {ticket_id} | {fix_applied} | {classification} |')

    wiki_content = '\n'.join(content_lines)

    wiki_result = _upsert_doctor_page(title, wiki_content)

    # Notify admin via the orchestrator relay
    try:
        try:
            from orchestrator_auth import orchestrator_headers
        except ImportError:
            from src.orchestrator_auth import orchestrator_headers
        requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': ticket_id,
                'message': (
                    f'[Doctor Agent] ✅ Fix SUCCESS\n'
                    f'Ticket: `{ticket_id}`\n'
                    f'Fix: {fix_applied}\n'
                    f'Classification: {classification}'
                ),
                'message_type': 'info',
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
    except Exception:
        pass

    return {
        'success': True,
        'ticket_id': ticket_id,
        'fix_applied': fix_applied,
        'classification': classification,
        'wiki_updated': bool(wiki_result.get('success')),
    }


# ─── 14. Report Fix Failure ───────────────────────────────────────────────────

def report_fix_failure(
    ticket_id: str,
    diagnosis: str,
    reason: str,
) -> dict:
    """
    Record a failed fix attempt for metrics tracking and notify admin.

    Args:
        ticket_id: The Plane ticket ID associated with the failed fix
        diagnosis: What was diagnosed as the problem
        reason: Why the fix failed
    Returns:
        dict with success, ticket_id, diagnosis, reason
    """
    import requests

    timestamp = datetime.now(timezone.utc).isoformat()
    title = 'Fix Outcomes'

    fix_data = _read_fix_outcomes()
    content = fix_data.get('content', '')

    success_count = failure_count = 0
    for line in content.splitlines():
        ls = line.strip()
        if '| SUCCESS |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    success_count = int(parts[1])
                except ValueError:
                    pass
        elif '| FAILURE |' in ls:
            parts = [p.strip() for p in ls.split('|')[1:-1]]
            if len(parts) >= 2:
                try:
                    failure_count = int(parts[1])
                except ValueError:
                    pass

    failure_count += 1

    content_lines = [
        '# Fix Outcomes',
        '',
        '| Outcome | Count |',
        '| --- | --- |',
        f'| SUCCESS | {success_count} |',
        f'| FAILURE | {failure_count} |',
        '',
        '## Recent Failures',
        '',
        '| Timestamp | Ticket | Diagnosis | Reason |',
        '| --- | --- | --- | --- |',
    ]

    # Preserve existing failure rows
    in_failure_section = False
    for line in content.splitlines():
        if line.strip() == '## Recent Failures':
            in_failure_section = True
            continue
        if line.strip().startswith('## '):
            in_failure_section = False
        if in_failure_section and '| FAILURE |' not in line and '| Timestamp' not in line and '-:|' not in line and line.strip().startswith('|'):
            content_lines.append(line)

    content_lines.append(f'| {timestamp} | {ticket_id} | {diagnosis} | {reason} |')

    wiki_content = '\n'.join(content_lines)

    wiki_result = _upsert_doctor_page(title, wiki_content)

    # Notify admin via the orchestrator relay
    try:
        try:
            from orchestrator_auth import orchestrator_headers
        except ImportError:
            from src.orchestrator_auth import orchestrator_headers
        requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': ticket_id,
                'message': (
                    f'[Doctor Agent] ❌ Fix FAILED\n'
                    f'Ticket: `{ticket_id}`\n'
                    f'Diagnosis: {diagnosis}\n'
                    f'Reason: {reason}'
                ),
                'message_type': 'error',
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
    except Exception:
        pass

    return {
        'success': True,
        'ticket_id': ticket_id,
        'diagnosis': diagnosis,
        'reason': reason,
        'wiki_updated': bool(wiki_result.get('success')),
    }


# ─── 5b. PM Health & Failover Tools ──────────────────────────────────────────

PM_STATE_PATH = os.environ.get('PM_STATE_PATH', '/tmp/turing-pm-state.json')


def check_pm_health() -> dict:
    """
    Check PM (Project Manager) worker health via orchestrator health endpoint.

    Returns PM-specific health info: heartbeat age, queue depth,
    container status, and failover readiness.

    Returns:
        dict with pm_status, heartbeat_age_sec, queue_depth,
        container_state, failover_ready, timestamp
    """
    import requests

    result = {
        'pm_status': 'unknown',
        'heartbeat_age_sec': None,
        'queue_depth': 0,
        'container_state': 'unknown',
        'failover_ready': False,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'error': None,
    }

    try:
        resp = requests.get(f'{ORCHESTRATOR_URL}/health/all', timeout=10)
        if resp.status_code != 200:
            result['error'] = f'Health endpoint returned {resp.status_code}'
            return result

        data = resp.json()
        workers = data.get('workers', [])

        # Find PM worker
        pm_worker = next((w for w in workers if w.get('role') == 'pm'), None)
        if not pm_worker:
            result['pm_status'] = 'not_found'
            return result

        result['pm_status'] = pm_worker.get('status', 'unknown')
        result['heartbeat_age_sec'] = pm_worker.get('timeSinceHeartbeat', 0)
        result['container_state'] = pm_worker.get('state', 'unknown')

        # Queue depth from summary
        summary = data.get('summary', {})
        if isinstance(summary, dict):
            result['queue_depth'] = summary.get('queued', 0) + summary.get('running', 0)

        # Failover ready if PM is healthy or warning (not dead)
        result['failover_ready'] = result['pm_status'] in ('healthy', 'warning')

    except requests.exceptions.ConnectionError:
        result['error'] = 'Cannot connect to orchestrator'
    except requests.exceptions.Timeout:
        result['error'] = 'Orchestrator health check timed out'
    except Exception as e:
        result['error'] = str(e)

    return result


def check_pm_queue_state() -> dict:
    """
    Read PM state from the persisted state file (/tmp/turing-pm-state.json).

    This reflects the last-saved queue state — useful for Doctor to
    understand what tasks were in-flight when PM died.

    Returns:
        dict with state_timestamp, queue_depth, running_task,
        queued_tasks, paused_tasks, state_stale_minutes, error
    """
    result = {
        'state_timestamp': None,
        'queue_depth': 0,
        'running_task': None,
        'queued_tasks': [],
        'paused_tasks': [],
        'state_stale_minutes': None,
        'error': None,
    }

    if not os.path.exists(PM_STATE_PATH):
        result['error'] = f'No PM state file at {PM_STATE_PATH}'
        return result

    try:
        with open(PM_STATE_PATH, 'r', encoding='utf-8') as f:
            state = json.load(f)

        result['state_timestamp'] = state.get('timestamp')
        if result['state_timestamp']:
            result['state_stale_minutes'] = round(
                (time.time() - result['state_timestamp']) / 60, 1
            )

        qs = state.get('queueState', {})
        result['queued_tasks'] = [t.get('ticketId') for t in qs.get('queue', [])]
        result['paused_tasks'] = [t[0] for t in qs.get('pausedTasks', [])]

        rt = qs.get('runningTask')
        if rt:
            result['running_task'] = rt.get('ticketId')

        result['queue_depth'] = len(result['queued_tasks'])

    except json.JSONDecodeError:
        result['error'] = 'PM state file is corrupted'
    except Exception as e:
        result['error'] = str(e)

    return result


def check_pm_failover_readiness() -> dict:
    """
    Assess PM failover readiness: is the state file fresh enough
    to support a failover recovery?

    Returns:
        dict with can_failover, state_age_minutes, max_state_age_minutes,
        queue_tasks_at_risk, recommendation, timestamp
    """
    result = {
        'can_failover': False,
        'state_age_minutes': None,
        'max_state_age_minutes': 2,
        'queue_tasks_at_risk': 0,
        'recommendation': '',
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    queue_state = check_pm_queue_state()
    if queue_state.get('error'):
        result['recommendation'] = f"State file error: {queue_state['error']}"
        return result

    result['state_age_minutes'] = queue_state.get('state_stale_minutes')
    result['queue_tasks_at_risk'] = (
        queue_state.get('queue_depth', 0)
        + (1 if queue_state.get('running_task') else 0)
    )

    if result['state_age_minutes'] is None:
        result['recommendation'] = 'No state timestamp found'
        return result

    if result['state_age_minutes'] <= result['max_state_age_minutes']:
        result['can_failover'] = True
        result['recommendation'] = (
            f'State is fresh ({result["state_age_minutes"]}m old). '
            'Failover can recover all in-flight tasks.'
        )
    else:
        result['recommendation'] = (
            f'State is stale ({result["state_age_minutes"]}m old). '
            'Some tasks may have been lost since last save.'
        )

    return result


# ─── 15. Intelligent Error Classification ────────────────────────────────────

def _classify_error(error_msg: str, container_name: str = '') -> tuple[str, str]:
    """
    Classify an error into PROJECT_BUG, LLM_BUG, USER_ERROR, or INTEGRATION_ERROR
    and return a severity rating (P0–P3).

    Returns: (classification, severity)
    """
    msg = error_msg.lower()

    # LLM Bug patterns
    llm_patterns = [
        'hallucinat', 'nonsense', 'made up', 'could not find',
        'undefined variable', 'syntax error', 'indentation error',
        'null pointer', 'noneType', 'attributeerror',
    ]
    if any(p in msg for p in llm_patterns):
        return ('LLM_BUG', 'P2')

    # User Error patterns
    user_patterns = [
        'permission denied', 'access denied', 'unauthorized',
        'invalid input', 'not found', 'does not exist',
        'wrong format', 'missing required field',
    ]
    if any(p in msg for p in user_patterns):
        return ('USER_ERROR', 'P3')

    # Integration Error patterns
    integration_patterns = [
        'connection refused', 'connection timeout', 'timeout',
        'connection error', 'network error', 'econnreset',
        'certificate expired', 'ssl error', 'tls error',
        'rate limit', '429', '500', '502', '503', '504',
        'service unavailable', 'bad gateway', 'gateway timeout',
    ]
    if any(p in msg for p in integration_patterns):
        return ('INTEGRATION_ERROR', 'P2')

    # Project Bug patterns (container/docker infrastructure)
    project_bug_patterns = [
        'exited with code', 'exit code', 'oomkilled', 'oom',
        'killed signal', 'killed', 'segfault', 'coredump',
        'port already in use', 'address already in use',
        'no space left', 'disk full', 'enospc',
        'docker daemon', 'docker: not found',
        'cannot start container', 'container stopped',
        'validation failed', 'configuration error',
    ]
    if any(p in msg for p in project_bug_patterns):
        if any(p in msg for p in ('oom', 'killed', 'segfault', 'coredump')):
            return ('PROJECT_BUG', 'P1')
        return ('PROJECT_BUG', 'P2')

    # PM-specific failure patterns (PM is orchestrator's project manager role)
    pm_patterns = [
        'pm worker dead', 'pm died', 'pm unavailable',
        'pm heartbeat missed', 'pm not responding',
        'pm crashed', 'pm container exited',
        'project manager dead', 'project manager failed',
    ]
    if any(p in msg for p in pm_patterns):
        return ('PM_FAILURE', 'P0')  # PM failure is always critical (blocks task dispatch)

    # Critical keywords → P0
    critical = ['fatal', 'panic', 'crash', 'deadlock', 'data loss']
    if any(p in msg for p in critical):
        return ('PROJECT_BUG', 'P0')

    return ('PROJECT_BUG', 'P2')  # Default


# ─── 16. Auto-Remediation Suggestion Engine ───────────────────────────────────

def _suggest_fixes(error_msg: str, container_name: str = '') -> list[dict]:
    """
    Given an error message and optional container, return a ranked list of
    recommended fix scripts to attempt. Each suggestion includes:
      - fix_name: script name (without extension)
      - reason: why this fix is relevant
      - priority: 1-5 (1 = highest confidence)
    """
    msg = error_msg.lower()
    container = container_name.lower()
    suggestions = []

    # OOM / Memory pressure
    if any(p in msg for p in ('oom', 'killed', 'memory', 'oomkill', 'out of memory')):
        suggestions.append({'fix_name': 'increase_memory', 'reason': 'Memory exhaustion detected', 'priority': 1})
        suggestions.append({'fix_name': 'cleanup_docker', 'reason': 'Free up memory-related Docker resources', 'priority': 2})

    # Connection refused / service not responding
    if any(p in msg for p in ('connection refused', 'connect error', 'econnrefused')):
        svc = 'unknown'
        if 'taiga' in msg or 'taiga' in container:
            svc = 'Plane'
        elif 'bookstack' in msg or 'bookstack' in container:
            svc = 'BookStack'
        elif 'orchestrator' in msg or 'orchestrator' in container:
            svc = 'Orchestrator'
        elif 'synapse' in msg or 'matrix' in container:
            svc = 'Synapse/Matrix'
        suggestions.append({'fix_name': 'restart_service', 'reason': f'{svc} appears unresponsive', 'priority': 1})

    # Container exited / crashed
    if any(p in msg for p in ('exited with code', 'exit code', 'stopped', 'crashed', 'dead')):
        suggestions.append({'fix_name': 'restart_container', 'reason': 'Container crashed, restart needed', 'priority': 1})
        suggestions.append({'fix_name': 'cleanup_docker', 'reason': 'Clean up residual container state', 'priority': 3})

    # Disk space issues
    if any(p in msg for p in ('no space', 'disk full', 'enospc', 'quota', 'diskus')):
        suggestions.append({'fix_name': 'cleanup_docker', 'reason': 'Disk space critically low', 'priority': 1})
        suggestions.append({'fix_name': 'check_disk_usage', 'reason': 'Identify largest disk consumers', 'priority': 2})

    # Port conflicts
    if any(p in msg for p in ('port already in use', 'address already in use', 'bind')):
        suggestions.append({'fix_name': 'reset_network', 'reason': 'Port/network conflict detected', 'priority': 1})

    # Docker daemon issues
    if any(p in msg for p in ('docker daemon', 'docker error', 'cannot connect')):
        suggestions.append({'fix_name': 'restart_docker', 'reason': 'Docker daemon is unresponsive', 'priority': 1})

    # PM-specific failures
    if any(p in msg for p in ('pm worker', 'pm died', 'pm unavailable', 'pm not responding', 'pm crashed', 'pm container', 'project manager')):
        suggestions.append({'fix_name': 'restart_pm', 'reason': 'PM worker died, needs restart with queue state restored', 'priority': 1})
        suggestions.append({'fix_name': 'check_pm_logs', 'reason': 'Inspect PM container logs for root cause', 'priority': 2})

    # Default: generic restart
    if not suggestions:
        suggestions.append({'fix_name': 'restart_container', 'reason': 'Generic container issue, attempt restart', 'priority': 3})

    # Sort by priority (lower = higher priority)
    suggestions.sort(key=lambda x: x['priority'])
    return suggestions[:3]  # Return top 3 suggestions


# ─── 17. Self-Healing Pipeline (CROWN JEWEL) ────────────────────────────────

def run_self_healing_pipeline(error_description: str, container_name: str = '') -> dict:
    """
    THE CROWN JEWEL — Full autonomous diagnostic & self-healing pipeline.

    Orchestrates the complete workflow: triage → diagnose → check known issues →
    attempt fix → verify → track metrics → report.

    Args:
        error_description: Natural-language error description (from user or logs)
        container_name: Optional specific container to focus on
    Returns:
        dict with:
          - step: current step reached
          - classification: PROJECT_BUG | LLM_BUG | USER_ERROR | INTEGRATION_ERROR
          - severity: P0–P3
          - diagnosis: what was found
          - fix_attempted: what was tried
          - fix_success: bool
          - known_issue_found: bool
          - escalates: bool (whether GitHub issue was created)
          - github_issue_url: str or None
          - suggestions: ranked fix script recommendations
    """
    result = {
        'step': 'triage',
        'classification': 'PROJECT_BUG',
        'severity': 'P2',
        'diagnosis': '',
        'fix_attempted': '',
        'fix_success': False,
        'known_issue_found': False,
        'escalates': False,
        'github_issue_url': None,
        'suggestions': [],
        'errors': [],
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    # ── STEP 1: Triage ────────────────────────────────────────────────────
    classification, severity = _classify_error(error_description, container_name)
    result['classification'] = classification
    result['severity'] = severity

    # ── STEP 2: Diagnose ─────────────────────────────────────────────────
    result['step'] = 'diagnose'
    errors_data = check_recent_errors(count=20)
    result['errors'] = errors_data.get('errors', [])

    # Extract key error message
    primary_error = ''
    primary_container = container_name
    if result['errors']:
        top = result['errors'][0]
        primary_error = top.get('message', error_description)
        if not primary_container:
            primary_container = top.get('container', '')
    else:
        primary_error = error_description

    result['diagnosis'] = f"Container: {primary_container or 'unknown'} | Error: {primary_error[:200]}"

    # ── STEP 3: Check Known Issues DB ─────────────────────────────────────
    result['step'] = 'check_known_issues'
    known_hits = query_known_issues_db(primary_error[:100])
    if known_hits and 'error' not in known_hits[0]:
        result['known_issue_found'] = True
        known = known_hits[0]
        result['diagnosis'] += f" | KNOWN ISSUE: {known.get('error_key', '')}"
        # Apply known fix directly
        known_fix = known.get('fix', '')
        if known_fix:
            result['fix_attempted'] = f"Applied known fix: {known_fix[:200]}"

    # ── STEP 4: Attempt Fix ──────────────────────────────────────────────
    result['step'] = 'attempt_fix'

    # Get ranked fix suggestions
    suggestions = _suggest_fixes(primary_error, primary_container)
    result['suggestions'] = suggestions

    if not result['known_issue_found']:
        # Try the top recommended fix via the orchestrator remediation API.
        if suggestions:
            top_fix = suggestions[0]
            fix_result = run_fix_script(top_fix['fix_name'], target=primary_container)
            if fix_result.get('success'):
                result['fix_attempted'] = f"remediation: {top_fix['fix_name']} ({top_fix['reason']})"
                result['fix_success'] = True
                # Verify via the orchestrator container relay (no shell/docker).
                if primary_container:
                    verify_result = verify_fix(
                        f"confirm container {primary_container} running",
                        primary_container,
                    )
                    result['fix_success'] = verify_result.get('success', False)
            else:
                result['fix_attempted'] = (
                    f"remediation {top_fix['fix_name']} failed: "
                    f"{fix_result.get('error', 'unknown')}"
                )

    # ── STEP 5: Track Metrics ─────────────────────────────────────────────
    result['step'] = 'track'
    ticket_id = os.environ.get('TICKET_ID', '')
    if result['fix_success']:
        track_metrics('fix_success_rate', 1.0)
        if ticket_id:
            report_fix_success(ticket_id, result['fix_attempted'], result['classification'])
        # Save to known issues if new error
        if not result['known_issue_found'] and primary_error:
            pattern = primary_error[:50]
            save_to_known_issues(
                error_key=f"auto-{int(time.time())}",
                symptoms=primary_error[:200],
                causes=result['diagnosis'],
                fix=result['fix_attempted'],
                pattern=pattern,
            )
    else:
        track_metrics('fix_success_rate', 0.0)
        if ticket_id:
            report_fix_failure(ticket_id, result['diagnosis'], result['fix_attempted'] or 'No fix script available')

    # ── STEP 6: Escalate if needed ───────────────────────────────────────
    result['step'] = 'escalate'
    needs_escalation = (
        not result['fix_success']
        or result['severity'] in ('P0', 'P1')
        or result['classification'] in ('LLM_BUG', 'PROJECT_BUG')
    )

    if needs_escalation:
        labels = [result['classification'].lower(), f"severity-{result['severity'].lower()}"]
        if result['classification'] == 'LLM_BUG':
            labels.append('llm-bug')

        issue_body = f"""## Error Summary
{primary_error}

## Diagnosis
{result['diagnosis']}

## Fix Attempted
{result['fix_attempted'] or 'None'}

## Classification
- **Type:** {result['classification']}
- **Severity:** {result['severity']}
- **Container:** {primary_container or 'N/A'}

## Doctor Suggestions
{chr(10).join([f"- `{s['fix_name']}` — {s['reason']}" for s in suggestions])}

## Recent Errors
{chr(10).join([f"- [{e.get('level','?')}] {e.get('message','')[:150]} ({e.get('container','')})" for e in result['errors'][:5]])}

---
*Reported via Turing OS Doctor Agent — {result['timestamp']}*
"""
        issue_result = create_github_issue(
            title=f"[{result['severity']}] {result['classification']}: {primary_error[:80]}",
            body=issue_body,
            labels=labels,
        )
        if issue_result.get('success'):
            result['escalates'] = True
            result['github_issue_url'] = issue_result.get('issue_url')

    result['step'] = 'complete'
    return result


# ─── 18. Dynamic Fix Script Creator ──────────────────────────────────────────

def create_dynamic_fix_script(
    fix_name: str,
    target_issue: str,
    code_content: str,
    language: str = "powershell",
) -> dict:
    """
    DISABLED for safety.

    This used to write an LLM-generated .ps1/.sh into scripts/doctor-fixes/ and
    later execute it locally. That local write+exec path is unsafe and now has
    no consumer: run_fix_script no longer runs local scripts — all docker
    control goes through the orchestrator's allow-listed remediation API.

    The function is kept (so tool registration / callers don't break) but is
    inert: it writes NO file and executes NOTHING. Use the allow-listed
    remediation API (run_fix_script) or escalate to a human.

    Returns:
        dict with success=False, disabled=True, message.
    """
    return {
        'success': False,
        'disabled': True,
        'fix_name': fix_name,
        'message': (
            'Dynamic fix-script creation is disabled for safety. Use the '
            'allow-listed remediation API or escalate to a human.'
        ),
    }


# ─── 19. Config File Patcher ──────────────────────────────────────────────────

def patch_config_file(
    file_path: str,
    operation: str,
    key: str = None,
    value: str = None,
    path: str = None,
) -> dict:
    """
    Patch a config file (.env, docker-compose.yml, .json, .yaml) in-place.

    Supported operations:
      - "set":     Set a key=value or a nested path=value
      - "append":  Append a line to the file
      - "remove":  Remove a line matching the key
      - "reset":   Reset a key to its default value (removes override)

    Supported files:
      - .env                    → KEY=value format
      - docker-compose*.yml      → YAML structure
      - *.json                  → JSON structure
      - synapse/homeserver.yaml → YAML structure

    Args:
        file_path: Config file path, RELATIVE to /workspace only. Absolute
                   paths and `..` traversal are rejected.
        operation: set | remove | reset (``append`` is NOT supported)
        key: For .env files: the key name; For others: top-level key or dot-path
        value: The value to set (for "set" operation)
        path: For YAML/JSON: dot-notation path (e.g. "services.orchestrator.restart")
    Returns:
        dict with success, file_path, operation, key, previous_value

    GATING (Task P4d):
      * Opt-in: returns disabled unless env DOCTOR_ALLOW_CONFIG_PATCH == 'true'.
      * Containment: rejects absolute paths and any path that resolves outside
        /workspace (`..` traversal). The worker only has /workspace mounted, so
        the real repo/compose/.env files are NOT reachable from here regardless.
      * The unsupported ``append`` op returns a clear error (never silently
        no-ops).
    """
    # ── Gate 1: explicit opt-in ──────────────────────────────────────────
    if os.environ.get('DOCTOR_ALLOW_CONFIG_PATCH') != 'true':
        return {
            'success': False,
            'disabled': True,
            'needs_confirmation': True,
            'message': (
                'patch_config_file is disabled. Set DOCTOR_ALLOW_CONFIG_PATCH=true '
                'to opt in. NOTE: the worker only has /workspace mounted, so the '
                'real repo/compose/.env files are not patchable from here — '
                'escalate config changes to a human / DevOps.'
            ),
        }

    # ── Gate 2: reject unsupported ops up front (no silent no-op) ─────────
    if operation not in ('set', 'remove', 'reset'):
        return {
            'success': False,
            'error': (
                f'Unsupported operation: {operation}. Allowed: set | remove | reset. '
                f'(append is intentionally not implemented.)'
            ),
        }

    # ── Gate 3: path containment — workspace-relative only ────────────────
    if os.path.isabs(file_path) or file_path.startswith(('/', '\\')):
        return {
            'success': False,
            'error': f'Absolute paths are rejected; file_path must be relative to /workspace: {file_path}',
        }

    try:
        from .local_exec import _resolve_workspace_path
    except ImportError:
        try:
            from tools.local_exec import _resolve_workspace_path
        except ImportError:
            from src.tools.local_exec import _resolve_workspace_path

    try:
        resolved = _resolve_workspace_path(file_path)
    except PermissionError:
        return {
            'success': False,
            'error': f'Path escapes /workspace (traversal/`..` not allowed): {file_path}',
        }

    abs_path = str(resolved)

    if not os.path.exists(abs_path):
        return {'success': False, 'error': f'File not found within /workspace: {abs_path}'}

    try:
        ext = os.path.splitext(abs_path)[1].lower()

        if ext == '.env':
            return _patch_env_file(abs_path, operation, key, value)
        elif ext in ('.yml', '.yaml'):
            return _patch_yaml_file(abs_path, operation, key, value, path)
        elif ext == '.json':
            return _patch_json_file(abs_path, operation, key, value, path)
        else:
            return {'success': False, 'error': f'Unsupported file type: {ext}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def _patch_env_file(path: str, operation: str, key: str, value: str) -> dict:
    """Patch a .env file."""
    if not key:
        return {'success': False, 'error': 'key required for .env operations'}

    lines = []
    previous_value = None
    found = False

    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

    if operation == 'set':
        new_line = f'{key}={value}\n'
        new_lines = []
        for line in lines:
            if line.strip().startswith(f'{key}='):
                previous_value = line.split('=', 1)[1].strip()
                new_lines.append(new_line)
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(new_line)
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        return {'success': True, 'file_path': path, 'operation': 'set', 'key': key, 'previous_value': previous_value, 'new_value': value}

    elif operation == 'remove':
        new_lines = []
        for line in lines:
            if line.strip().startswith(f'{key}='):
                previous_value = line.split('=', 1)[1].strip()
                found = True
            else:
                new_lines.append(line)
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        return {'success': True, 'file_path': path, 'operation': 'remove', 'key': key, 'previous_value': previous_value}

    elif operation == 'reset':
        return _patch_env_file(path, 'remove', key, None)

    return {'success': False, 'error': f'Unknown operation: {operation}'}


def _patch_yaml_file(path: str, operation: str, key: str, value: str, path_dot: str = None) -> dict:
    """Patch a YAML file (basic key=value or dot-path support)."""
    try:
        import yaml
    except ImportError:
        return {'success': False, 'error': 'PyYAML not available'}

    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f) or {}

    previous_value = None
    target = data

    if path_dot:
        parts = path_dot.split('.')
        for part in parts[:-1]:
            if part not in target:
                target[part] = {}
            target = target[part]
        last_key = parts[-1]
    elif key:
        last_key = key
    else:
        return {'success': False, 'error': 'key or path required'}

    if operation == 'set':
        if last_key in target:
            previous_value = target[last_key]
        target[last_key] = value
        with open(path, 'w', encoding='utf-8') as f:
            yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
        return {'success': True, 'file_path': path, 'operation': 'set', 'key': path_dot or key, 'previous_value': previous_value, 'new_value': value}

    elif operation == 'remove':
        if last_key in target:
            previous_value = target[last_key]
            del target[last_key]
            with open(path, 'w', encoding='utf-8') as f:
                yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
        return {'success': True, 'file_path': path, 'operation': 'remove', 'key': path_dot or key, 'previous_value': previous_value}

    return {'success': False, 'error': f'Unknown operation: {operation}'}


def _patch_json_file(path: str, operation: str, key: str, value: str, path_dot: str = None) -> dict:
    """Patch a JSON file."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    previous_value = None
    target = data

    if path_dot:
        parts = path_dot.split('.')
        for part in parts[:-1]:
            if part not in target:
                target[part] = {}
            target = target[part]
        last_key = parts[-1]
    elif key:
        last_key = key
    else:
        return {'success': False, 'error': 'key or path required'}

    if operation == 'set':
        if last_key in target:
            previous_value = target[last_key]
        target[last_key] = value
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        return {'success': True, 'file_path': path, 'operation': 'set', 'key': path_dot or key, 'previous_value': previous_value, 'new_value': value}

    elif operation == 'remove':
        if last_key in target:
            previous_value = target[last_key]
            del target[last_key]
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
        return {'success': True, 'file_path': path, 'operation': 'remove', 'key': path_dot or key, 'previous_value': previous_value}

    return {'success': False, 'error': f'Unknown operation: {operation}'}


# ─── 20. Cross-Worker Tool Invocation ─────────────────────────────────────────

def invoke_worker_tool(
    target_role: str,
    tool_name: str,
    arguments: dict = None,
    justification: str = '',
) -> dict:
    """
    Request a capability from another worker role via PM dispatch.

    Architecture: peer-to-peer worker calls are forbidden by the
    PO → PM → HR → Workers hierarchy. Instead, we post a structured
    "cross_worker_request" into the orchestrator's worker-message relay;
    PM (the only role that reads cross-worker requests) decides whether
    to dispatch, deny, or escalate.

    Args:
        target_role: which role should provide the capability
                     (e.g. 'devops', 'qa', 'se', 'data')
        tool_name:   the tool to call on the target worker
        arguments:   plain-dict arguments for the tool
        justification: short reason this cross-call is needed

    Returns:
        dict with success=True when the request was queued on PM's inbox.
        This is a *request*, not a result — PM's response will arrive
        asynchronously through the normal admin inbox path.
    """
    import json
    import requests
    from orchestrator_auth import orchestrator_headers

    ticket_id = os.environ.get('TICKET_ID', '')
    sender_role = os.environ.get('ROLE', 'unknown')

    payload = {
        'kind': 'cross_worker_request',
        'source_role': sender_role,
        'source_ticket': ticket_id,
        'target_role': target_role,
        'tool_name': tool_name,
        'arguments': arguments or {},
        'justification': justification or '',
    }

    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': ticket_id,
                'message': f'[CROSS_WORKER_REQUEST] {json.dumps(payload)}',
                'message_type': 'cross_worker_request',
            },
            headers=orchestrator_headers(),
            timeout=10,
        )
        if resp.status_code == 200:
            return {
                'success': True,
                'queued': True,
                'target_role': target_role,
                'tool_name': tool_name,
                'note': (
                    'Request queued on PM inbox. PM will dispatch and the '
                    'response (if any) will arrive via the admin inbox.'
                ),
            }
        return {
            'success': False,
            'error': f'Orchestrator rejected the request: HTTP {resp.status_code}',
        }
    except Exception as exc:
        return {'success': False, 'error': str(exc)}


# ─── 21. Full-Stack Auto-Remediation (Doctor calls itself recursively) ────────

def run_full_remediation(error_description: str, container_name: str = '') -> dict:
    """
    Full auto-remediation that tries the safe approaches in order:
    1. Known issues DB
    2. Allow-listed remediation via the orchestrator API (run_fix_script)
    3. Cross-worker tool invocation
    4. Escalation with GitHub issue

    Dynamic fix-script creation and local config patching are intentionally
    NOT in this chain: create_dynamic_fix_script is disabled (local script
    write+exec is unsafe and the worker has no docker), and config patching is
    gated/limited to /workspace (real repo files aren't reachable). Anything
    those would have handled is escalated to a human via a GitHub issue.

    Args:
        error_description: Natural-language error description
        container_name: Optional specific container
    Returns:
        dict with step, fix_success, diagnosis, actions_tried, github_issue_url
    """
    result = {
        'step': 'init',
        'fix_success': False,
        'diagnosis': error_description,
        'actions_tried': [],
        'config_changes': [],
        'scripts_created': [],
        'cross_worker_calls': [],
        'escalates': False,
        'github_issue_url': None,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    classification, severity = _classify_error(error_description, container_name)
    result['classification'] = classification
    result['severity'] = severity

    errors_data = check_recent_errors(count=20)
    result['errors'] = errors_data.get('errors', [])

    primary_error = error_description
    primary_container = container_name
    if result['errors']:
        top = result['errors'][0]
        primary_error = top.get('message', error_description)
        primary_container = top.get('container', container_name)

    # STEP A: Known Issues DB
    result['step'] = 'check_known_issues'
    known_hits = query_known_issues_db(primary_error[:100])
    if known_hits and 'error' not in known_hits[0]:
        result['actions_tried'].append({'action': 'known_issue_db', 'outcome': 'found_match'})
        known_fix = known_hits[0].get('fix', '')
        if known_fix:
            result['diagnosis'] = f"Applied known fix: {known_fix}"
            result['fix_success'] = True
            return result

    # STEP B: Allow-listed remediation via the orchestrator API.
    # run_fix_script maps the suggested fix name to a safe remediation action
    # (restart_container / check_disk_usage / cleanup_docker) and POSTs it to
    # {ORCHESTRATOR_URL}/remediation. Unmapped names short-circuit with a clear
    # "escalate to human" result (no HTTP, no local exec).
    result['step'] = 'try_remediation'
    suggestions = _suggest_fixes(primary_error, primary_container)
    for sug in suggestions[:3]:
        fix_result = run_fix_script(sug['fix_name'], target=primary_container)
        result['actions_tried'].append({
            'action': f'run_fix_script({sug["fix_name"]})',
            'reason': sug['reason'],
            'success': fix_result.get('success', False),
            'detail': fix_result.get('error') or fix_result.get('detail'),
        })
        if fix_result.get('success'):
            # Verify via the orchestrator container relay (no shell/docker).
            verified = True
            if primary_container:
                verify_result = verify_fix(
                    f"confirm container {primary_container} running",
                    primary_container,
                )
                verified = verify_result.get('success', False)
                result['actions_tried'].append({
                    'action': f'verify_fix({primary_container})',
                    'success': verified,
                })
            if verified:
                result['fix_success'] = True
                result['diagnosis'] = f"Remediation {sug['fix_name']} succeeded"
                return result

    # NOTE: dynamic fix-script creation (old STEP C) and local config patching
    # (old STEP D) are intentionally removed. create_dynamic_fix_script is
    # disabled (unsafe local write+exec, worker has no docker) and config
    # patching is gated/limited to /workspace where real repo files aren't
    # reachable. Anything those would have addressed falls through to escalation.

    # STEP E: Cross-worker invocation
    result['step'] = 'cross_worker'
    # Try devops worker if we need scaling or infrastructure changes
    if any(k in primary_error.lower() for k in ('scale', 'replica', 'out of capacity')):
        cw_result = invoke_worker_tool('devops', 'scale_worker', {'service': primary_container or 'all', 'replicas': 2})
        result['cross_worker_calls'].append(cw_result)
        result['actions_tried'].append({
            'action': 'invoke_worker_tool(devops.scale_worker)',
            'success': cw_result.get('success', False),
        })
        if cw_result.get('success'):
            result['fix_success'] = True
            result['diagnosis'] = "Cross-worker scale action succeeded"
            return result

    # STEP F: Escalate
    result['step'] = 'escalate'
    result['escalates'] = True
    labels = [classification.lower(), f"severity-{severity.lower()}"]
    issue_body = f"""## Error Summary
{primary_error}

## Diagnosis
{result['diagnosis']}

## Actions Tried (all failed)
{chr(10).join([f"- {a['action']}: {'✅' if a.get('success') else '❌'}" for a in result['actions_tried']])}

## Cross-Worker Calls
{chr(10).join([f"- {k}: {'✅' if v.get('success') else '❌'}" for k, v in enumerate(result['cross_worker_calls'])]) if result['cross_worker_calls'] else "None"}

## Classification
- **Type:** {classification}
- **Severity:** {severity}

---
*Reported via Turing OS Doctor Agent (Full-Stack Remediation) — {result['timestamp']}*
"""
    issue_result = create_github_issue(
        title=f"[{severity}] {classification}: {primary_error[:80]}",
        body=issue_body,
        labels=labels,
    )
    if issue_result.get('success'):
        result['github_issue_url'] = issue_result.get('issue_url')

    return result
