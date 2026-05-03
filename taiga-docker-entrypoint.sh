#!/bin/bash
set -e

# Load ADMIN_USER and ADMIN_PASSWORD from .env (mounted at /app/.env)
if [[ -f /app/.env ]]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        export "$key=$value"
    done < /app/.env
fi

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD}"

# Run original entrypoint in background
/taiga-back/docker/entrypoint.sh "$@" &
PID=$!

# Wait for Django to be ready
for i in $(seq 1 30); do
    sleep 1
    if curl -s http://localhost:8000/api/v1/ > /dev/null 2>&1; then
        echo "Taiga API is ready"
        break
    fi
    echo "Waiting for Taiga API... ($i)"
done

# Create/update admin user
python manage.py shell << PYEOF
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(username='$ADMIN_USER').exists():
    User.objects.create_superuser('$ADMIN_USER', 'admin@$ADMIN_USER.local', '$ADMIN_PASS')
    print("Admin user created: $ADMIN_USER")
else:
    user = User.objects.get(username='$ADMIN_USER')
    user.set_password('$ADMIN_PASS')
    user.save()
    print("Admin password updated: $ADMIN_USER")
PYEOF

# Keep container running
wait $PID
