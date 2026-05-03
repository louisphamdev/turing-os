#!/bin/bash
# =============================================================================
# Docker Maintenance Script - Turing OS
# Mục đích: Dọn dẹp Docker resource để tránh phình theo thời gian
# Hướng dẫn: Chạy manual hoặc setup cron job
# =============================================================================

set -e

LOG_FILE="/var/log/docker-maintenance.log"
RETENTION_DAYS=7

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# =============================================================================
# 1. Container Log Cleanup - Xoá log cũ, giới hạn size
# =============================================================================
cleanup_container_logs() {
    log "${YELLOW}==> Cleaning container logs...${NC}"
    
    # Disable logging driver json-file nếu muốn triệt để
    # Hoặc chỉ truncate logs > 50MB
    
    # Truncate container logs nếu > 50MB
    for container in $(docker ps --format '{{.Names}}'); do
        log_file=$(docker inspect --format '{{.LogPath}}' "$container" 2>/dev/null || true)
        if [ -f "$log_file" ]; then
            size=$(stat -c%s "$log_file" 2>/dev/null || echo 0)
            max_size=52428800  # 50MB
            
            if [ "$size" -gt "$max_size" ]; then
                log "  Truncating log for $container (size: $size bytes)"
                truncate -s 0 "$log_file"
            fi
        fi
    done
    
    log "${GREEN}  Container logs cleaned${NC}"
}

# =============================================================================
# 2. Dọn temporary files trong containers
# =============================================================================
cleanup_temp_files() {
    log "${YELLOW}==> Cleaning temp files in containers...${NC}"
    
    for container in $(docker ps -q); do
        name=$(docker inspect --format '{{.Name}}' "$container" | sed 's/^\///')
        
        # Xóa /tmp/* trong container (an toàn vì container vẫn chạy được)
        docker exec "$container" rm -rf /tmp/* 2>/dev/null || true
        
        # Xóa cache nếu có
        docker exec "$container" rm -rf /root/.cache/* 2>/dev/null || true
        docker exec "$container" rm -rf /var/cache/apk/* 2>/dev/null || true
        
        log "  Cleaned temp for: $name"
    done
    
    log "${GREEN}  Temp files cleaned${NC}"
}

# =============================================================================
# 3. Dọn unused images, volumes, networks
# =============================================================================
cleanup_unused_resources() {
    log "${YELLOW}==> Cleaning unused Docker resources...${NC}"
    
    # Remove stopped containers
    stopped=$(docker ps -f status=exited -q | wc -l)
    if [ "$stopped" -gt 0 ]; then
        docker container prune -f
        log "  Removed $stopped stopped containers"
    fi
    
    # Remove unused images
    unused_images=$(docker images -f dangling=true -q | wc -l)
    if [ "$unused_images" -gt 0 ]; then
        docker image prune -f
        log "  Removed $unused_images dangling images"
    fi
    
    # Remove unused volumes
    unused_volumes=$(docker volume ls -f dangling=true -q | wc -l)
    if [ "$unused_volumes" -gt 0 ]; then
        docker volume prune -f
        log "  Removed $unused_volumes unused volumes"
    fi
    
    # Remove unused networks
    docker network prune -f 2>/dev/null || true
    
    log "${GREEN}  Unused resources cleaned${NC}"
}

# =============================================================================
# 4. System cleanup - bộ nhớ, swap
# =============================================================================
system_cleanup() {
    log "${YELLOW}==> System cleanup...${NC}"
    
    # Drop caches (cần root)
    if [ "$EUID" -eq 0 ]; then
        sync
        echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
        log "  Memory caches dropped"
    else
        log "  Skipping drop_caches (need root)"
    fi
    
    # Clear journal logs older than retention days
    if [ -d /var/log/journal ]; then
        journalctl --vacuum-time="${RETENTION_DAYS}days" 2>/dev/null || true
        log "  Journal logs trimmed to ${RETENTION_DAYS} days"
    fi
    
    log "${GREEN}  System cleanup done${NC}"
}

# =============================================================================
# 5. Health check - báo cáo disk usage
# =============================================================================
health_report() {
    log "${YELLOW}==> Docker Disk Usage Report${NC}"
    
    echo ""
    docker system df
    echo ""
    
    # Top 5 largest volumes
    log "Top 5 largest volumes:"
    docker volume ls -q | while read vol; do
        size=$(docker volume inspect --format '{{.Size}}' "$vol" 2>/dev/null || echo "unknown")
        log "  $vol: $size"
    done | head -5
    
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    log "${GREEN}=== Docker Maintenance Started ===${NC}"
    
    cleanup_container_logs
    cleanup_temp_files
    cleanup_unused_resources
    system_cleanup
    health_report
    
    log "${GREEN}=== Docker Maintenance Completed ===${NC}"
}

# Run
main "$@"
