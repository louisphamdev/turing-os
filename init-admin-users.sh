#!/bin/bash
# Auto-create the Matrix admin + bot users for HITL chat.
# Plane CE has its own onboarding UI — generate an API token there manually
# and paste it into PLANE_API_TOKEN in .env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load from .env
if [[ -f "$ENV_FILE" ]]; then
    while IFS== read -r key value; do
        # Strip CR (Windows line endings) and skip comments / blanks.
        key="${key%$'\r'}"; value="${value%$'\r'}"
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        # DOCKER_HOST in .env targets the orchestrator container, not the
        # host shell — exporting unix:///var/run/docker.sock breaks the
        # docker CLI on Windows (Docker Desktop uses npipe there).
        [[ "$key" == "DOCKER_HOST" ]] && continue
        export "$key=$value"
    done < "$ENV_FILE"
fi

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD}"
SYNAPSE_API_URL="${SYNAPSE_API_URL:-http://localhost:8008}"
# No baked-in secret. Require it from the environment / .env. The live value is
# read back out of the running container below; that path still wins when set.
: "${SYNAPSE_REGISTRATION_SECRET:?Set SYNAPSE_REGISTRATION_SECRET in .env (must match registration_shared_secret in synapse/homeserver.yaml)}"
REGISTRATION_SECRET="${SYNAPSE_REGISTRATION_SECRET}"
MATRIX_BOT_USER="${MATRIX_BOT_USER:-turing-bot}"
MATRIX_BOT_PASS="${MATRIX_BOT_PASS:-BotPass123!}"

echo "--- Turing OS Auto User Setup ---"

# Synapse generates its own registration_shared_secret on first boot and
# writes it to /data/homeserver.yaml. Our env var doesn't override that, so
# read the active value from the container — otherwise HMAC will mismatch.
if docker ps --filter "name=synapse" --format "{{.Names}}" 2>/dev/null | grep -q synapse; then
    SECRET_FROM_FILE=$(docker exec synapse sh -c 'awk -F"\"" "/^registration_shared_secret:/ {print \$2}" /data/homeserver.yaml' 2>/dev/null | tr -d '\r')
    if [[ -n "$SECRET_FROM_FILE" ]]; then
        REGISTRATION_SECRET="$SECRET_FROM_FILE"
        echo "Synapse: using registration_shared_secret from homeserver.yaml"
    fi
fi

upsert_env() {
    local key="$1" value="$2"
    local tmp_file

    tmp_file=$(mktemp)

    if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
        awk -v key="$key" -v value="$value" '
            $0 ~ "^" key "=" {
                print key "=" value
                next
            }
            { print }
        ' "$ENV_FILE" > "$tmp_file"
    else
        if [[ -f "$ENV_FILE" ]]; then
            cat "$ENV_FILE" > "$tmp_file"
        fi
        printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
    fi

    mv "$tmp_file" "$ENV_FILE"
}

wait_for() {
    local url=$1 name=$2 maxwait=30
    echo -n "Waiting for $name..."
    for i in $(seq 1 $maxwait); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null | grep -q "200\|301\|302" && { echo " OK"; return 0; }
        echo -n "."
        sleep 1
    done
    echo " TIMEOUT"
    return 1
}

token_is_usable() {
    local token="$1"
    [[ -n "$token" && "$token" != "ERROR" ]]
}

# ─── MATRIX ──────────────────────────────────────────────────────────────────
echo "--- MATRIX ---"
wait_for "${SYNAPSE_API_URL}/_matrix/client/versions" "Synapse"

register_synapse_user() {
    local user=$1 pass=$2 admin=$3
    local admin_mode mac response token

    NONCE=$(curl -s "${SYNAPSE_API_URL}/_synapse/admin/v1/register" | grep -o '"nonce":"[^"]*"' | cut -d'"' -f4)
    if [[ -z "$NONCE" ]]; then
        echo ""
        return 0
    fi

    if [[ "$admin" == "true" ]]; then
        admin_mode="admin"
    else
        admin_mode="notadmin"
    fi

    mac=$(printf '%s\0%s\0%s\0%s' "$NONCE" "$user" "$pass" "$admin_mode" | openssl dgst -sha1 -hmac "$REGISTRATION_SECRET" | awk '{print $NF}')
    response=$(curl -s -X POST "${SYNAPSE_API_URL}/_synapse/admin/v1/register" \
        -H "Content-Type: application/json" \
        -d "{\"nonce\":\"$NONCE\",\"username\":\"$user\",\"password\":\"$pass\",\"admin\":$admin,\"displayname\":\"$user\",\"mac\":\"$mac\"}")
    token=$(echo "$response" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$token" ]]; then
        echo "$token"
    else
        echo ""
    fi
}

login_synapse_user() {
    local user=$1 pass=$2
    local login token

    login=$(curl -s -X POST "${SYNAPSE_API_URL}/_matrix/client/r0/login" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$pass\"}")
    token=$(echo "$login" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$token" ]]; then
        echo "$token"
    else
        echo ""
    fi
}

echo "Matrix admin: @$ADMIN_USER:localhost"
MATRIX_ADMIN_TOKEN=$(register_synapse_user "$ADMIN_USER" "$ADMIN_PASS" true)

if ! token_is_usable "$MATRIX_ADMIN_TOKEN"; then
    MATRIX_ADMIN_TOKEN=$(login_synapse_user "$ADMIN_USER" "$ADMIN_PASS")
fi

if token_is_usable "$MATRIX_ADMIN_TOKEN"; then
    echo "OK: Matrix admin token obtained"
else
    echo "WARN: Matrix admin login failed"
fi

echo "Matrix bot: @$MATRIX_BOT_USER:localhost"
MATRIX_BOT_TOKEN=$(register_synapse_user "$MATRIX_BOT_USER" "$MATRIX_BOT_PASS" false)

if ! token_is_usable "$MATRIX_BOT_TOKEN"; then
    MATRIX_BOT_TOKEN=$(login_synapse_user "$MATRIX_BOT_USER" "$MATRIX_BOT_PASS")
fi

if token_is_usable "$MATRIX_BOT_TOKEN"; then
    upsert_env "MATRIX_BOT_TOKEN" "$MATRIX_BOT_TOKEN"
    echo "OK: Matrix bot token obtained"
else
    echo "WARN: Matrix bot login failed"
fi

upsert_env "MATRIX_ADMIN_USER_ID" "@$ADMIN_USER:localhost"

# ─── PLANE ───────────────────────────────────────────────────────────────────
echo "--- PLANE ---"
PLANE_BOOTSTRAP_SCRIPT="$SCRIPT_DIR/scripts/bootstrap-plane.sh"
if [[ -x "$PLANE_BOOTSTRAP_SCRIPT" ]]; then
    bash "$PLANE_BOOTSTRAP_SCRIPT" || echo "WARN: Plane bootstrap script returned non-zero"
elif [[ -f "$PLANE_BOOTSTRAP_SCRIPT" ]]; then
    bash "$PLANE_BOOTSTRAP_SCRIPT" || echo "WARN: Plane bootstrap script returned non-zero"
else
    echo "SKIP: $PLANE_BOOTSTRAP_SCRIPT not found"
fi

echo "--- DONE ---"
echo "Matrix: @$ADMIN_USER:localhost"
