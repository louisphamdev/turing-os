#!/bin/bash
# Auto-create admin and bot users for Taiga and Matrix
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load from .env
if [[ -f "$ENV_FILE" ]]; then
    while IFS== read -r key value; do
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        export "$key=$value"
    done < "$ENV_FILE"
fi

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD}"
TAIGA_SCHEME="${TAIGA_SCHEME:-http}"
TAIGA_DOMAIN="${TAIGA_DOMAIN:-localhost:9000}"
SYNAPSE_API_URL="${SYNAPSE_API_URL:-http://localhost:8008}"
REGISTRATION_SECRET="${SYNAPSE_REGISTRATION_SECRET:-f643143e19d68d088741f6ca465894bb6964ca284b5d2c58a8dcc3348750f4e4}"
MATRIX_BOT_USER="${MATRIX_BOT_USER:-turing-bot}"
MATRIX_BOT_PASS="${MATRIX_BOT_PASS:-BotPass123!}"

echo "--- Turing OS Auto User Setup ---"

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

# ─── TAIGA ───────────────────────────────────────────────────────────────────
echo "--- TAIGA ---"
wait_for "${TAIGA_SCHEME}://${TAIGA_DOMAIN}/api/v1/" "Taiga API"

if docker ps --filter "name=turing_taiga_back" --format "{{.Names}}" 2>/dev/null | grep -q "turing_taiga_back"; then
    echo "Creating Taiga superuser..."
    docker exec \
        -e TURING_ADMIN_USER="$ADMIN_USER" \
        -e TURING_ADMIN_PASS="$ADMIN_PASS" \
        -i turing_taiga_back python manage.py shell << 'PYEOF'
import os
from django.contrib.auth import get_user_model

User = get_user_model()
username = os.environ['TURING_ADMIN_USER']
password = os.environ['TURING_ADMIN_PASS']
email = f'admin@{username}.local'

if not User.objects.filter(username=username).exists():
    User.objects.create_superuser(username, email, password)
    print("OK")
else:
    u = User.objects.get(username=username)
    u.email = email
    u.set_password(password)
    u.save()
    print("OK")
PYEOF
fi

echo "Getting Taiga auth token..."
TAIGA_RESP=$(curl -s -X POST "${TAIGA_SCHEME}://${TAIGA_DOMAIN}/api/v1/auth" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"normal\",\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")

TAIGA_TOKEN=$(echo "$TAIGA_RESP" | grep -o '"auth_token":"[^"]*"' | cut -d'"' -f4)

if [[ -n "$TAIGA_TOKEN" ]]; then
    echo "OK: Taiga token obtained"
    upsert_env "TAIGA_API_KEY" "$TAIGA_TOKEN"
else
    echo "FAIL: Taiga token"
fi

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

echo "--- DONE ---"
echo "Taiga: $([[ -n "$TAIGA_TOKEN" ]] && echo OK || echo FAIL)"
echo "Matrix: @$ADMIN_USER:localhost" 