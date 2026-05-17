"""
Helper for authenticating worker → orchestrator HTTP calls.

Default path uses the worker's CONSUMER_TOKEN (per-worker JWT, rotatable,
revocable) for every webhook. The orchestrator middleware
(orchestrator/src/api/middleware.ts:makeRequireWorkerToken) validates it
via the same JWT verifier as gateway calls.

WORKER_INTERNAL_TOKEN remains as a transitional fallback for workers that
don't yet have a CONSUMER_TOKEN (e.g. bootstrap scripts).
"""

import os
from typing import Dict


def orchestrator_headers(extra: Dict[str, str] | None = None) -> Dict[str, str]:
    """Return headers for a worker→orchestrator request.

    Preference order:
      1. CONSUMER_TOKEN (JWT) — set by docker.ts on spawn for every worker.
      2. WORKER_INTERNAL_TOKEN — legacy static secret, kept for non-worker
         callers (init scripts, doctor agents running outside a worker).
    """
    headers: Dict[str, str] = {}
    consumer_token = os.environ.get('CONSUMER_TOKEN', '')
    if consumer_token:
        headers['Authorization'] = f'Bearer {consumer_token}'
    else:
        legacy = os.environ.get('WORKER_INTERNAL_TOKEN', '')
        if legacy:
            headers['Authorization'] = f'Bearer {legacy}'
    if extra:
        headers.update(extra)
    return headers
