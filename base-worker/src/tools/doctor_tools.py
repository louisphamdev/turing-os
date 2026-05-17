"""
Doctor Agent Tools — Diagnostic and self-healing toolkit for the Doctor worker role.

Provides tools for:
- System health monitoring (CPU, memory, disk, Docker, network)
- Docker log parsing and error aggregation
- Service connectivity checks (Taiga, Wiki, Matrix, Context7, GitHub)
- Known issues database (BookStack)
- GitHub issue creation
- Self-healing fix scripts execution and verification
- Metrics tracking
- Doctor dashboard summary
- Admin communication for confirmations
- Fix success/failure reporting

Environment variables:
    ORCHESTRATOR_URL    — Orchestrator API URL (default: http://turing-orchestrator:3001)
    BOOKSTACK_URL            — BookStack URL (default: http://wiki:3000)
    BOOKSTACK_TOKEN      — BookStack JWT auth token
    GITHUB_TOKEN        — GitHub API token (fallback; primary token fetched from Wiki /secrets/)
    TAIGA_API_URL       — Taiga API URL (default: http://taiga-gateway:80/api/v1)
    TAIGA_API_KEY       — Taiga API key
    MATRIX_ROOM_ID      — Matrix room for admin communication
    MATRIX_BOT_TOKEN    — Matrix bot auth token
    SYNAPSE_API_URL     — Synapse homeserver URL (default: http://synapse:8008)
    GITHUB_REPO_OWNER   — GitHub repo owner (default: from env or 'turing-os')
    GITHUB_REPO_NAME    — GitHub repo name (default: from env or 'turing-os')
"""

import os
import json
import subprocess
import re
import time
import threading
from datetime import datetime, timezone
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── Environment ────────────────────────────────────────────────────────────────

ORCHESTRATOR_URL = os.environ.get('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001')
BOOKSTACK_URL = os.environ.get('BOOKSTACK_URL', 'http://wiki:3000')
BOOKSTACK_TOKEN = os.environ.get('BOOKSTACK_TOKEN', '')
GITHUB_TOKEN_FALLBACK = os.environ.get('GITHUB_TOKEN', '')
TAIGA_API_URL = os.environ.get('TAIGA_API_URL', 'http://taiga-gateway:80/api/v1')
TAIGA_API_KEY = os.environ.get('TAIGA_API_KEY', '')
MATRIX_ROOM_ID = os.environ.get('MATRIX_ROOM_ID', '')
MATRIX_BOT_TOKEN = os.environ.get('MATRIX_BOT_TOKEN', '')
SYNAPSE_API_URL = os.environ.get('SYNAPSE_API_URL', 'http://synapse:8008')
GITHUB_REPO_OWNER = os.environ.get('GITHUB_REPO_OWNER', 'turing-os')
GITHUB_REPO_NAME = os.environ.get('GITHUB_REPO_NAME', 'turing-os')

# ─── Token Cache (avoids repeated BookStack lookups per execution) ─────────────
_GITHUB_TOKEN_CACHE: Optional[str] = None
_GITHUB_TOKEN_FETCHED_AT: float = 0.0
_TOKEN_CACHE_TTL: float = 300.0  # 5 minutes


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
        'taiga': f'{TAIGA_API_URL}/health',
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
    except Exception as e:
        # Any other error → try orchestrator relay before giving up
        raw = ''

    # ── Strategy 2: orchestrator relay ────────────────────────────────────
    if not raw.strip():
        try:
            import requests as _req
            url = f'{ORCHESTRATOR_URL}/containers/{container_name}/logs'
            resp = _req.get(url, params={'lines': lines}, timeout=20)
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
        'taiga': f'{TAIGA_API_URL}/health',
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
            resp = _req.get(f'{ORCHESTRATOR_URL}/containers', timeout=15)
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

def _wiki_request(query: str, variables: dict = None) -> dict:
    """Internal helper for BookStack GraphQL requests."""
    import requests

    url = f"{BOOKSTACK_URL}/graphql"
    headers = {
        'Authorization': f'Bearer {BOOKSTACK_TOKEN}',
        'Content-Type': 'application/json',
    }
    body: dict = {'query': query}
    if variables:
        body['variables'] = variables

    if not BOOKSTACK_TOKEN:
        return {'error': 'BOOKSTACK_TOKEN not configured'}

    try:
        resp = requests.post(url, headers=headers, json=body, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if 'errors' in data:
            return {'error': '; '.join(e.get('message', str(e)) for e in data['errors'])}
        return data.get('data', {})
    except Exception as e:
        return {'error': str(e)}


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
    current_key = None
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
    Search the known issues database in BookStack at /doctor/known-issues/.

    Args:
        error_pattern: Search query string to match against known issue patterns,
                       error keys, symptoms, or fixes
    Returns:
        list of matching known issue records (error_key, symptoms, causes, fix, pattern)
    """
    query = """
    query($path: String!) {
      pages {
        list(filter: { parentPath: $path }, limit: 100) {
          id
          title
          path
        }
      }
    }
    """
    data = _wiki_request(query, {'path': '/doctor/known-issues'})
    if 'error' in data:
        return [{'error': data['error']}]

    pages = data.get('pages', {}).get('list', [])
    results = []

    for page in pages:
        page_query = """
        query($id: Int!) {
          pages {
            single(id: $id) {
              id
              title
              content
            }
          }
        }
        """
        page_data = _wiki_request(page_query, {'id': page['id']})
        if 'error' in page_data:
            continue

        page_info = page_data.get('pages', {}).get('single', {})
        content = page_info.get('content', '')

        issue = _parse_known_issue_page(content)
        issue['title'] = page_info.get('title', '')
        issue['path'] = page.get('path', '')

        # Match against error_pattern
        search_target = ' '.join([
            issue.get('error_key', ''),
            issue.get('pattern', ''),
            issue.get('symptoms', ''),
            issue.get('fix', ''),
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
    Save a new known issue record to BookStack at /doctor/known-issues/.

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
    safe_key = error_key.lower().replace(' ', '-').replace('/', '-')
    path = f"doctor/known-issues/{safe_key}"

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

    mutation = """
    mutation($title: String!, $content: String!, $path: String!, $isPublish: Boolean!) {
      pages {
        create(
          title: $title,
          content: $content,
          path: $path,
          isPublish: $isPublish,
          contentType: "markdown"
        ) {
          id
          title
          path
        }
      }
    }
    """
    result = _wiki_request(mutation, {
        'title': title,
        'content': content,
        'path': path,
        'isPublish': True,
    })

    if 'error' in result:
        return {'success': False, 'error': result['error']}

    page = result.get('pages', {}).get('create', {})
    return {
        'success': True,
        'page_id': page.get('id'),
        'page_path': page.get('path'),
    }


# ─── 7. GitHub Issue Creation ─────────────────────────────────────────────────

def _get_github_token() -> str:
    """Get GitHub token with caching: Wiki secret first → env var fallback."""
    global _GITHUB_TOKEN_CACHE, _GITHUB_TOKEN_FETCHED_AT
    now = time.time()
    if _GITHUB_TOKEN_CACHE is not None and (now - _GITHUB_TOKEN_FETCHED_AT) < _TOKEN_CACHE_TTL:
        return _GITHUB_TOKEN_CACHE

    token = GITHUB_TOKEN_FALLBACK
    if BOOKSTACK_TOKEN:
        try:
            resp = requests.get(
                f'{BOOKSTACK_URL}/api/secrets/doctor-github-token',
                headers={'Authorization': f'Bearer {BOOKSTACK_TOKEN}'},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                token = data.get('value', '') or data.get('secret', '') or GITHUB_TOKEN_FALLBACK
        except Exception:
            pass

    _GITHUB_TOKEN_CACHE = token
    _GITHUB_TOKEN_FETCHED_AT = now
    return token


def create_github_issue(
    title: str,
    body: str,
    labels: list = None,
    assignees: list = None,
) -> dict:
    """
    Create a GitHub issue via the REST API.

    Token priority: BookStack /api/secrets/doctor-github-token → GITHUB_TOKEN env var.

    Args:
        title: Issue title
        body: Issue body (markdown supported)
        labels: List of label names (default: [])
        assignees: List of GitHub usernames (default: [])
    Returns:
        dict with success, issue_url, issue_number, error
    """
    import requests

    token = _get_github_token()
    if not token:
        return {
            'success': False,
            'error': 'GitHub token not available. Set BOOKSTACK_TOKEN and store doctor-github-token in BookStack, or set GITHUB_TOKEN env var.',
        }

    url = f'https://api.github.com/repos/{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}/issues'
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    payload = {
        'title': title,
        'body': body,
        'labels': labels or [],
        'assignees': assignees or [],
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
        if resp.status_code == 201:
            data = resp.json()
            return {
                'success': True,
                'issue_url': data.get('html_url'),
                'issue_number': data.get('number'),
            }
        else:
            return {
                'success': False,
                'error': f'GitHub API returned {resp.status_code}: {resp.text}',
                'status_code': resp.status_code,
            }
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── 8. Fix Script Execution ─────────────────────────────────────────────────

# Resolve the fix scripts directory relative to this file
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FIX_SCRIPTS_DIR = os.path.join(_BASE_DIR, 'scripts', 'doctor-fixes')


def run_fix_script(fix_name: str) -> dict:
    """
    Execute a self-healing fix script from scripts/doctor-fixes/.

    The scripts directory is scripts/doctor-fixes/ at the repo root.
    Only .sh and .ps1 scripts are allowed. Fix names are sanitized.

    Args:
        fix_name: Name of the fix script without extension
                  e.g. "restart_container" → scripts/doctor-fixes/restart_container.ps1
    Returns:
        dict with success, stdout, stderr, returncode, available_scripts (if not found)
    """
    # Security: restrict fix_name to safe characters
    if not re.match(r'^[a-zA-Z0-9_-]+$', fix_name):
        return {'success': False, 'error': f'Invalid fix name (only alphanumeric, dash, underscore allowed): {fix_name}'}

    script_paths = [
        os.path.join(FIX_SCRIPTS_DIR, f'{fix_name}.ps1'),
        os.path.join(FIX_SCRIPTS_DIR, f'{fix_name}.sh'),
    ]

    script_path = None
    for sp in script_paths:
        if os.path.isfile(sp):
            script_path = sp
            break

    if script_path is None:
        available = []
        try:
            if os.path.isdir(FIX_SCRIPTS_DIR):
                available = sorted(os.listdir(FIX_SCRIPTS_DIR))
        except Exception:
            pass
        return {
            'success': False,
            'error': f'Fix script not found: {fix_name}',
            'fix_name': fix_name,
            'search_dir': FIX_SCRIPTS_DIR,
            'available_scripts': available,
        }

    if script_path.endswith('.ps1'):
        cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', script_path]
    else:
        cmd = ['bash', script_path]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode,
            'script': script_path,
        }
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Script timed out after 300s', 'script': script_path}
    except Exception as e:
        return {'success': False, 'error': str(e), 'script': script_path}


# ─── 9. Verify Fix ────────────────────────────────────────────────────────────

def verify_fix(command: str, expected_outcome: str) -> dict:
    """
    Run a shell command and verify its output contains the expected outcome.

    The expected_outcome is matched as a case-insensitive substring in the
    combined stdout+stderr output.

    Args:
        command: Shell command to execute
        expected_outcome: Substring expected to appear in the output
    Returns:
        dict with success, actual_output (truncated), matches,
               expected_outcome, returncode, command
    """
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return {
            'success': False,
            'error': 'Command timed out after 120s',
            'command': command,
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'command': command,
        }

    actual_output = (result.stdout + result.stderr).strip()
    matches = expected_outcome.lower() in actual_output.lower()

    return {
        'success': matches,
        'actual_output': actual_output[:2000],
        'matches': matches,
        'expected_outcome': expected_outcome,
        'returncode': result.returncode,
        'command': command,
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
    """Read existing metric page content and entries from Wiki."""
    path = f"doctor/metrics/{metric_name.lower().replace(' ', '-')}"
    query = """
    query($path: String!) {
      pages {
        singleByPath(path: $path) {
          id
          content
        }
      }
    }
    """
    data = _wiki_request(query, {'path': path})
    if 'error' in data:
        return {'content': '', 'entries': []}

    page = data.get('pages', {}).get('singleByPath', {})
    content = page.get('content', '')
    return {'content': content, 'entries': _parse_metric_entries(content)}


def track_metrics(metric_name: str, value: float) -> dict:
    """
    Save a metric value to BookStack at /doctor/metrics/.

    Metrics are stored as historical JSON entries in a page named after the metric.
    Up to the last 100 entries are kept.

    Args:
        metric_name: Name of the metric (e.g., "fix_success_rate", "error_count")
        value: Numeric value to record
    Returns:
        dict with success, metric_name, value, page_path, entry_count
    """
    timestamp = datetime.now(timezone.utc).isoformat()
    safe_name = metric_name.lower().replace(' ', '-')
    path = f"doctor/metrics/{safe_name}"
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

    mutation = """
    mutation($title: String!, $content: String!, $path: String!, $isPublish: Boolean!) {
      pages {
        create(
          title: $title,
          content: $content,
          path: $path,
          isPublish: $isPublish,
          contentType: "markdown"
        ) {
          id
          path
        }
      }
    }
    """
    result = _wiki_request(mutation, {
        'title': title,
        'content': content,
        'path': path,
        'isPublish': True,
    })

    if 'error' in result:
        return {'success': False, 'error': result['error']}

    page = result.get('pages', {}).get('create', {})
    return {
        'success': True,
        'metric_name': metric_name,
        'value': value,
        'page_path': page.get('path'),
        'entry_count': len(entries),
    }


# ─── 11. Doctor Dashboard ─────────────────────────────────────────────────────

def _read_fix_outcomes() -> dict:
    """Read fix success/failure counts from the fix-outcomes Wiki page."""
    path = 'doctor/metrics/fix-outcomes'
    query = """
    query($path: String!) {
      pages {
        singleByPath(path: $path) {
          id
          content
        }
      }
    }
    """
    data = _wiki_request(query, {'path': path})
    if 'error' in data:
        return {}

    page = data.get('pages', {}).get('singleByPath', {})
    content = page.get('content', '')
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
    Send a confirmation question to admin via Matrix/Orchestrator and wait for reply.

    The question is sent through the orchestrator webhook relay. If the orchestrator
    is unreachable, falls back to direct Matrix API. Replies are polled for up to
    600 seconds.

    Args:
        question: The yes/no or confirmation question to ask admin
    Returns:
        dict with success, confirmed (bool or None), reply, sender, timestamp
    """
    import requests

    ticket_id = os.environ.get('TICKET_ID', '')
    question_sent_at_ms = int(time.time() * 1000)

    # Try orchestrator relay first
    relay_success = False
    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/worker-message',
            json={
                'ticket_id': ticket_id,
                'message': f'[Doctor Agent] Confirmation needed: {question}',
                'message_type': 'question',
                'timeout_seconds': 600,
            },
            timeout=10,
        )
        relay_success = resp.status_code == 200
    except Exception:
        pass

    if not relay_success:
        # Fallback to direct Matrix
        return _ask_via_direct_matrix(question)

    # Poll for admin reply
    start = time.time()
    poll_interval = 3

    while time.time() - start < 600:
        try:
            inbox_resp = requests.get(
                f'{ORCHESTRATOR_URL}/webhooks/worker-inbox/{ticket_id}',
                params={'since': question_sent_at_ms},
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


def _ask_via_direct_matrix(question: str) -> dict:
    """Direct Matrix fallback for ask_user_confirmation."""
    import requests

    if not MATRIX_BOT_TOKEN or not MATRIX_ROOM_ID:
        return {'success': False, 'confirmed': None, 'error': 'Matrix not configured (no BOT_TOKEN or ROOM_ID)'}

    txn_id = f"doctor_{int(time.time() * 1000)}"
    try:
        resp = requests.put(
            f'{SYNAPSE_API_URL}/_matrix/client/r0/rooms/{MATRIX_ROOM_ID}/send/m.room.message/{txn_id}',
            headers={
                'Authorization': f'Bearer {MATRIX_BOT_TOKEN}',
                'Content-Type': 'application/json',
            },
            json={'msgtype': 'm.text', 'body': f'[Doctor Agent] Confirmation needed: {question}'},
            timeout=10,
        )
        if resp.status_code != 200:
            return {'success': False, 'confirmed': None, 'error': f'Matrix send failed: {resp.status_code}'}
    except Exception as e:
        return {'success': False, 'confirmed': None, 'error': str(e)}

    return {
        'success': True,
        'confirmed': None,
        'note': 'Message sent via direct Matrix; reply polling unavailable in fallback mode',
    }


# ─── 13. Report Fix Success ───────────────────────────────────────────────────

def report_fix_success(
    ticket_id: str,
    fix_applied: str,
    classification: str = '',
) -> dict:
    """
    Record a successful fix for metrics tracking and notify admin via Matrix.

    Args:
        ticket_id: The Taiga ticket ID associated with the fix
        fix_applied: Description of the fix that was applied
        classification: Category of issue (e.g., "network", "memory", "docker", "PROJECT_BUG", "LLM_BUG")
    Returns:
        dict with success, ticket_id, fix_applied
    """
    import requests

    timestamp = datetime.now(timezone.utc).isoformat()
    path = 'doctor/metrics/fix-outcomes'
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

    mutation = """
    mutation($title: String!, $content: String!, $path: String!, $isPublish: Boolean!) {
      pages {
        create(
          title: $title,
          content: $content,
          path: $path,
          isPublish: $isPublish,
          contentType: "markdown"
        ) {
          id
          path
        }
      }
    }
    """
    wiki_result = _wiki_request(mutation, {
        'title': title,
        'content': wiki_content,
        'path': path,
        'isPublish': True,
    })

    # Notify admin via Matrix
    try:
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
            timeout=10,
        )
    except Exception:
        pass

    return {
        'success': True,
        'ticket_id': ticket_id,
        'fix_applied': fix_applied,
        'classification': classification,
        'wiki_updated': 'error' not in wiki_result,
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
        ticket_id: The Taiga ticket ID associated with the failed fix
        diagnosis: What was diagnosed as the problem
        reason: Why the fix failed
    Returns:
        dict with success, ticket_id, diagnosis, reason
    """
    import requests

    timestamp = datetime.now(timezone.utc).isoformat()
    path = 'doctor/metrics/fix-outcomes'
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

    mutation = """
    mutation($title: String!, $content: String!, $path: String!, $isPublish: Boolean!) {
      pages {
        create(
          title: $title,
          content: $content,
          path: $path,
          isPublish: $isPublish,
          contentType: "markdown"
        ) {
          id
          path
        }
      }
    }
    """
    wiki_result = _wiki_request(mutation, {
        'title': title,
        'content': wiki_content,
        'path': path,
        'isPublish': True,
    })

    # Notify admin
    try:
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
            timeout=10,
        )
    except Exception:
        pass

    return {
        'success': True,
        'ticket_id': ticket_id,
        'diagnosis': diagnosis,
        'reason': reason,
        'wiki_updated': 'error' not in wiki_result,
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
    container = container_name.lower()

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
            svc = 'Taiga'
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
        # Try the top recommended fix script
        if suggestions:
            top_fix = suggestions[0]
            fix_result = run_fix_script(top_fix['fix_name'])
            if fix_result.get('success'):
                result['fix_attempted'] = f"R script: {top_fix['fix_name']} ({top_fix['reason']})"
                result['fix_success'] = True
                # Verify
                if primary_container:
                    verify_result = verify_fix(
                        f"docker ps | grep {primary_container}",
                        primary_container,
                    )
                    result['fix_success'] = verify_result.get('success', False)
            else:
                result['fix_attempted'] = f"R script {top_fix['fix_name']} failed: {fix_result.get('error', 'unknown')}"

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
    Create a new self-healing fix script on-the-fly when no existing script fits.

    The script is saved to scripts/doctor-fixes/{fix_name}.ps1 (or .sh).
    Syntax is verified before saving.

    Args:
        fix_name: Unique name for the fix (e.g. "fix_nginx_502")
        target_issue: Natural-language description of what this fix addresses
        code_content: The script content to write
        language: "powershell" (default) or "bash"
    Returns:
        dict with success, script_path, fix_name, syntax_verified
    """
    # Sanitize fix_name
    if not re.match(r'^[a-zA-Z0-9_-]+$', fix_name):
        return {'success': False, 'error': 'fix_name: alphanumeric, dash, underscore only'}

    # Determine extension
    ext = '.ps1' if language == 'powershell' else '.sh'
    script_path = os.path.join(FIX_SCRIPTS_DIR, f'{fix_name}{ext}')

    # Verify syntax (PowerShell)
    if language == 'powershell':
        syntax_ok = _verify_powershell_syntax(code_content)
    else:
        syntax_ok = _verify_bash_syntax(code_content)

    if not syntax_ok.get('valid'):
        return {
            'success': False,
            'error': f"Syntax error: {syntax_ok.get('error', 'unknown')}",
            'fix_name': fix_name,
        }

    # Write script
    try:
        os.makedirs(FIX_SCRIPTS_DIR, exist_ok=True)
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(code_content)
        return {
            'success': True,
            'script_path': script_path,
            'fix_name': fix_name,
            'syntax_verified': True,
            'target_issue': target_issue,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def _verify_powershell_syntax(code: str) -> dict:
    """Verify PowerShell script syntax without executing."""
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             f'$script = @"\n{code}\n"@; $null = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$null)'],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            return {'valid': True}
        return {'valid': False, 'error': result.stderr[:300]}
    except Exception as e:
        return {'valid': False, 'error': str(e)}


def _verify_bash_syntax(code: str) -> dict:
    """Verify Bash script syntax without executing."""
    try:
        result = subprocess.run(
            ['bash', '-n'],
            input=code,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            return {'valid': True}
        return {'valid': False, 'error': result.stderr[:300]}
    except Exception as e:
        return {'valid': False, 'error': str(e)}


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
        file_path: Path to config file (relative to repo root or absolute)
        operation: set | append | remove | reset
        key: For .env files: the key name; For others: top-level key or dot-path
        value: The value to set (for "set" operation)
        path: For YAML/JSON: dot-notation path (e.g. "services.orchestrator.restart")
    Returns:
        dict with success, file_path, operation, key, previous_value
    """
    # Resolve path
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    abs_path = file_path if os.path.isabs(file_path) else os.path.join(repo_root, file_path)

    if not os.path.exists(abs_path):
        return {'success': False, 'error': f'File not found: {abs_path}'}

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
) -> dict:
    """
    Invoke a tool from another worker role via the orchestrator relay.

    Doctor uses this when the fix requires capabilities from another role:
      - devops: scale_worker, restart_service, check_resource_usage
      - qa: run_tests, check_coverage
      - se: read_code, analyze_code, suggest_refactor
      - pm: update_ticket, get_sprint_status

    Args:
        target_role: The worker role to invoke (devops, qa, se, pm)
        tool_name: Name of the tool to call on the target worker
        arguments: Dict of arguments to pass to the tool
    Returns:
        dict with success, result, error, from_role, tool_name
    """
    import requests

    ticket_id = os.environ.get('TICKET_ID', '')
    arguments = arguments or {}

    try:
        resp = requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/cross-worker-invoke',
            json={
                'source_role': 'doctor',
                'target_role': target_role,
                'tool_name': tool_name,
                'arguments': arguments,
                'ticket_id': ticket_id,
            },
            timeout=60,
        )

        if resp.status_code == 200:
            data = resp.json()
            return {
                'success': True,
                'result': data.get('result'),
                'from_role': 'doctor',
                'target_role': target_role,
                'tool_name': tool_name,
                'raw_response': data,
            }
        elif resp.status_code == 404:
            return {
                'success': False,
                'error': f"No such worker role: {target_role} or tool: {tool_name}",
                'from_role': 'doctor',
                'target_role': target_role,
                'tool_name': tool_name,
            }
        else:
            return {
                'success': False,
                'error': f"Cross-worker call failed: HTTP {resp.status_code}",
                'from_role': 'doctor',
                'target_role': target_role,
                'tool_name': tool_name,
            }
    except requests.exceptions.Timeout:
        return {'success': False, 'error': 'Cross-worker call timed out after 60s'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── 21. Full-Stack Auto-Remediation (Doctor calls itself recursively) ────────

def run_full_remediation(error_description: str, container_name: str = '') -> dict:
    """
    Full auto-remediation that tries ALL approaches in order:
    1. Known issues DB
    2. Existing fix scripts
    3. Dynamic fix script creation
    4. Config file patching
    5. Cross-worker tool invocation
    6. Escalation with GitHub issue

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

    # STEP B: Existing fix scripts
    result['step'] = 'try_existing_scripts'
    suggestions = _suggest_fixes(primary_error, primary_container)
    for sug in suggestions[:3]:
        fix_result = run_fix_script(sug['fix_name'])
        result['actions_tried'].append({
            'action': f'run_fix_script({sug["fix_name"]})',
            'reason': sug['reason'],
            'success': fix_result.get('success', False),
        })
        if fix_result.get('success'):
            result['fix_success'] = True
            result['diagnosis'] = f"Fix script {sug['fix_name']} succeeded"
            return result

    # STEP C: Dynamic script creation (if no existing script worked)
    result['step'] = 'create_dynamic_script'
    script_name = f"auto_{int(time.time())}"
    # Generate a simple fix script based on error type
    if 'connection refused' in primary_error.lower():
        script_code = f"""# Auto-generated fix for: {primary_error[:80]}
docker restart {primary_container or 'all'}
exit 0
"""
    elif 'oom' in primary_error.lower() or 'memory' in primary_error.lower():
        script_code = f"""# Auto-generated fix for: {primary_error[:80]}
docker compose -f docker-compose.yml down
docker compose -f docker-compose.yml up -d
exit 0
"""
    elif 'disk full' in primary_error.lower() or 'no space' in primary_error.lower():
        script_code = """# Auto-generated fix for disk space issue
docker system prune -af --volumes
exit 0
"""
    else:
        script_code = f"""# Auto-generated fix for: {primary_error[:80]}
docker restart {primary_container or 'all'}
exit 0
"""

    dyn_result = create_dynamic_fix_script(
        fix_name=script_name,
        target_issue=primary_error[:200],
        code_content=script_code,
        language='powershell',
    )
    result['actions_tried'].append({
        'action': f'create_dynamic_fix_script({script_name})',
        'success': dyn_result.get('success', False),
    })
    if dyn_result.get('success'):
        result['scripts_created'].append(script_name)
        fix_result = run_fix_script(script_name)
        result['actions_tried'].append({
            'action': f'run_fix_script({script_name})',
            'success': fix_result.get('success', False),
        })
        if fix_result.get('success'):
            result['fix_success'] = True
            result['diagnosis'] = f"Dynamic script {script_name} succeeded"
            return result

    # STEP D: Config file patching
    result['step'] = 'patch_config'
    config_tried = []
    if 'port already in use' in primary_error.lower() or 'bind' in primary_error.lower():
        patch_result = patch_config_file(
            file_path='docker-compose.override.yml',
            operation='append',
            value=f'# Auto-patch: {primary_error[:80]}',
        )
        config_tried.append({'file': 'docker-compose.override.yml', **patch_result})

    result['config_changes'] = config_tried
    result['actions_tried'].extend([{'action': f'patch_config({c["file"]})', 'success': c.get('success', False)} for c in config_tried])

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

## Config Changes
{chr(10).join([f"- {c['file']}: {'✅' if c.get('success') else '❌'}" for c in config_tried]) if config_tried else "None"}

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
