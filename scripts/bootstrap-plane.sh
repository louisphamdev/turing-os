#!/bin/bash
# Bootstrap Plane CE: create admin user + workspace + project + API token.
# Output (captured by init-admin-users.sh):
#   PLANE_PROJECT_ID=<uuid>
#   PLANE_API_TOKEN=<token>
#
# Defensive: every step is wrapped in try/except so a single model-schema
# change in Plane only loses the step that hit it, not the whole script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ -f "$ENV_FILE" ]]; then
    while IFS== read -r key value; do
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        export "$key=$value"
    done < "$ENV_FILE"
fi

PLANE_ADMIN_EMAIL="${PLANE_ADMIN_EMAIL:-admin@turing.local}"
PLANE_ADMIN_PASSWORD="${PLANE_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-Admin123!}}"
PLANE_WORKSPACE_SLUG="${PLANE_WORKSPACE_SLUG:-turing}"
PLANE_WORKSPACE_NAME="${PLANE_WORKSPACE_NAME:-Turing}"
PLANE_PROJECT_NAME="${PLANE_PROJECT_NAME:-Turing OS}"
PLANE_PROJECT_IDENTIFIER="${PLANE_PROJECT_IDENTIFIER:-TURI}"
PLANE_CONTAINER="${PLANE_CONTAINER:-turing_plane_api}"

# ─── Wait for plane-api container to be up ──────────────────────────────────
echo -n "Waiting for $PLANE_CONTAINER..."
for i in $(seq 1 60); do
    state=$(docker inspect -f '{{.State.Status}}' "$PLANE_CONTAINER" 2>/dev/null || echo "missing")
    if [[ "$state" == "running" ]]; then
        # Health-probe the Django app — manage.py exits 0 once migrations done.
        if docker exec "$PLANE_CONTAINER" python -c "import django; django.setup()" 2>/dev/null; then
            echo " OK"
            break
        fi
    fi
    echo -n "."
    sleep 2
done

# ─── Run the bootstrap inside the container ─────────────────────────────────
BOOTSTRAP_OUTPUT=$(docker exec \
    -e PLANE_ADMIN_EMAIL="$PLANE_ADMIN_EMAIL" \
    -e PLANE_ADMIN_PASSWORD="$PLANE_ADMIN_PASSWORD" \
    -e PLANE_WORKSPACE_SLUG="$PLANE_WORKSPACE_SLUG" \
    -e PLANE_WORKSPACE_NAME="$PLANE_WORKSPACE_NAME" \
    -e PLANE_PROJECT_NAME="$PLANE_PROJECT_NAME" \
    -e PLANE_PROJECT_IDENTIFIER="$PLANE_PROJECT_IDENTIFIER" \
    -i "$PLANE_CONTAINER" python manage.py shell 2>&1 << 'PYEOF' || true
import os, sys, traceback

def emit(line):
    print(f"PLANE_BOOTSTRAP::{line}", flush=True)

try:
    from django.contrib.auth import get_user_model
    User = get_user_model()
    email = os.environ['PLANE_ADMIN_EMAIL']
    password = os.environ['PLANE_ADMIN_PASSWORD']

    user = User.objects.filter(email=email).first()
    if not user:
        try:
            user = User.objects.create_superuser(email=email, password=password)
        except TypeError:
            # Plane's User model may not accept create_superuser kwargs.
            user = User(email=email, username=email, is_active=True, is_staff=True, is_superuser=True)
            user.set_password(password)
            user.save()
    else:
        user.set_password(password)
        user.is_active = True
        for attr in ('is_password_autoset', 'is_email_verified'):
            if hasattr(user, attr):
                setattr(user, attr, False if attr == 'is_password_autoset' else True)
        user.save()
    emit(f"USER_OK={user.id}")
except Exception as exc:
    emit(f"USER_ERR={exc}")
    traceback.print_exc()
    sys.exit(0)

# ─── Workspace ──────────────────────────────────────────────────────────────
try:
    from plane.db.models import Workspace, WorkspaceMember
    slug = os.environ['PLANE_WORKSPACE_SLUG']
    name = os.environ['PLANE_WORKSPACE_NAME']
    ws = Workspace.objects.filter(slug=slug).first()
    if not ws:
        ws = Workspace.objects.create(slug=slug, name=name, owner=user, created_by=user)
    WorkspaceMember.objects.update_or_create(
        workspace=ws, member=user,
        defaults={'role': 20, 'created_by': user},
    )
    emit(f"WS_OK={ws.id}")
    emit(f"WS_SLUG={ws.slug}")
except Exception as exc:
    emit(f"WS_ERR={exc}")
    traceback.print_exc()

# ─── Project ────────────────────────────────────────────────────────────────
try:
    from plane.db.models import Project, ProjectMember
    pname = os.environ['PLANE_PROJECT_NAME']
    pident = os.environ['PLANE_PROJECT_IDENTIFIER']
    project = Project.objects.filter(workspace=ws, name=pname).first()
    if not project:
        project = Project.objects.create(
            workspace=ws,
            name=pname,
            identifier=pident,
            created_by=user,
            project_lead=user,
        )
    ProjectMember.objects.update_or_create(
        project=project, member=user, workspace=ws,
        defaults={'role': 20, 'created_by': user},
    )
    emit(f"PROJECT_OK={project.id}")
except Exception as exc:
    emit(f"PROJECT_ERR={exc}")
    traceback.print_exc()

# ─── API token ──────────────────────────────────────────────────────────────
try:
    from plane.db.models import APIToken
    token_obj = APIToken.objects.filter(user=user, label='turing-bootstrap').first()
    if not token_obj:
        token_obj = APIToken.objects.create(
            user=user, label='turing-bootstrap',
            workspace=ws, created_by=user,
        )
    token_value = getattr(token_obj, 'token', None) or getattr(token_obj, 'user_token', None)
    emit(f"TOKEN_OK={token_value}")
except Exception as exc:
    emit(f"TOKEN_ERR={exc}")
    traceback.print_exc()
PYEOF
)

# ─── Parse output ───────────────────────────────────────────────────────────
parse_line() {
    local key="$1"
    echo "$BOOTSTRAP_OUTPUT" | awk -F'=' "/PLANE_BOOTSTRAP::${key}=/{print substr(\$0, index(\$0,\"=\")+1)}" | head -1
}

USER_ID=$(parse_line "USER_OK")
WS_ID=$(parse_line "WS_OK")
PROJECT_ID=$(parse_line "PROJECT_OK")
API_TOKEN=$(parse_line "TOKEN_OK")

upsert_env() {
    local key="$1" value="$2"
    local tmp_file
    tmp_file=$(mktemp)
    if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
        awk -v key="$key" -v value="$value" '
            $0 ~ "^" key "=" { print key "=" value; next }
            { print }
        ' "$ENV_FILE" > "$tmp_file"
    else
        if [[ -f "$ENV_FILE" ]]; then cat "$ENV_FILE" > "$tmp_file"; fi
        printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
    fi
    mv "$tmp_file" "$ENV_FILE"
}

if [[ -n "$USER_ID" && -n "$WS_ID" && -n "$PROJECT_ID" && -n "$API_TOKEN" ]]; then
    upsert_env "PLANE_WORKSPACE_SLUG" "$PLANE_WORKSPACE_SLUG"
    upsert_env "PLANE_PROJECT_ID" "$PROJECT_ID"
    upsert_env "PLANE_API_TOKEN" "$API_TOKEN"
    echo "OK: Plane bootstrapped (user=$USER_ID, workspace=$WS_ID, project=$PROJECT_ID)"
    echo "    API token saved to .env (PLANE_API_TOKEN)"
else
    echo "WARN: Plane bootstrap incomplete"
    echo "  User:    ${USER_ID:-MISSING}"
    echo "  Workspace: ${WS_ID:-MISSING}"
    echo "  Project: ${PROJECT_ID:-MISSING}"
    echo "  Token:   $([[ -n $API_TOKEN ]] && echo 'OK' || echo 'MISSING')"
    echo ""
    echo "Manual onboarding:"
    echo "  1. Open http://localhost:9000"
    echo "  2. Sign up with the admin email above and complete onboarding"
    echo "  3. Generate an API token in Profile -> API Tokens"
    echo "  4. Paste into PLANE_API_TOKEN in .env, then \`make restart\`"
    echo ""
    echo "Bootstrap output (last 30 lines):"
    echo "$BOOTSTRAP_OUTPUT" | tail -30
fi
