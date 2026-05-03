# =============================================================================
# Docker Resource Limits & Optimizations for docker-compose.yml
# Apply these settings to prevent Docker from growing unbounded over time
# =============================================================================

# =============================================================================
# ADD TO .env FILE:
# =============================================================================
# Docker logging limits (prevents log files from growing forever)
# DOCKER_LOG_MAX_SIZE=10m
# DOCKER_LOG_MAX_FILE=3

# =============================================================================
# ADD TO EACH SERVICE in docker-compose.yml:
# =============================================================================
# Example for a typical service:

#   service_name:
#     image: your-image
#     # ... existing config ...
#     
#     # === RESOURCE LIMITS ===
#     deploy:
#       resources:
#         limits:
#           memory: 512M        # Hard limit
#           cpus: '0.5'         # Max 50% CPU
#         reservations:
#           memory: 256M        # Soft guarantee
#     
#     # === LOGGING with rotation ===
#     logging:
#       driver: "json-file"
#       options:
#         max-size: "10m"       # Max 10MB per log file
#         max-file: "3"         # Keep 3 files (30MB max per service)
#     
#     # === TMPFS for temp files (ramdisk) ===
#     tmpfs:
#       - /tmp:size=100M,noexec,nosuid,mode=1777
#     
#     # === ULIMITS ===
#     ulimits:
#       nofile:
#         soft: 1024
#         hard: 4096
#       nproc:
#         soft: 512
#         hard: 1024

# =============================================================================
# APPLY TO EXISTING docker-compose.yml:
# =============================================================================
# Run this script to patch the docker-compose.yml with optimizations
# OR manually add the deploy, logging, tmpfs, and ulimits sections

# =============================================================================
# IMPORTANT: Not all Docker Compose versions support all features
# Check with: docker compose version
# =============================================================================
