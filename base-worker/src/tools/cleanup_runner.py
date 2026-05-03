#!/usr/bin/env python3
"""
Internal Cleanup Runner for Worker Containers
Runs periodic cleanup tasks without requiring cron daemon
Can be called from main application or as a background thread
"""

import asyncio
import os
import shutil
import logging
from datetime import datetime, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ContainerCleanup:
    """Handles cleanup tasks within a container"""
    
    def __init__(self):
        self.workspace = Path("/workspace")
        self.temp_dirs = [
            "/tmp",
            "/var/tmp", 
            "/root/.cache",
            self.workspace / "tmp"
        ]
        self.max_log_size_mb = 10
        
    def cleanup_temp_files(self) -> dict:
        """Remove all temp files"""
        deleted_count = 0
        freed_bytes = 0
        
        for temp_dir in self.temp_dirs:
            path = Path(temp_dir)
            if not path.exists():
                continue
                
            try:
                for item in path.iterdir():
                    try:
                        size = self._get_size(item)
                        if item.is_file():
                            item.unlink()
                            freed_bytes += size
                            deleted_count += 1
                        elif item.is_dir():
                            shutil.rmtree(item)
                            freed_bytes += size  
                            deleted_count += 1
                    except (PermissionError, FileNotFoundError):
                        pass
            except Exception as e:
                logger.warning(f"Error cleaning {temp_dir}: {e}")
                
        return {"deleted": deleted_count, "freed_mb": freed_bytes / 1024 / 1024}
    
    def truncate_large_logs(self, max_size_mb: int = 50) -> list:
        """Truncate log files larger than max_size_mb"""
        truncated = []
        log_dirs = ["/var/log", "/workspace/logs", self.workspace]
        
        for log_dir in log_dirs:
            path = Path(log_dir)
            if not path.exists():
                continue
                
            for log_file in path.rglob("*.log"):
                try:
                    size_mb = log_file.stat().st_size / 1024 / 1024
                    if size_mb > max_size_mb:
                        with open(log_file, 'w') as f:
                            f.write(f"[truncated at {datetime.now().isoformat()}]\n")
                        truncated.append(str(log_file))
                except Exception:
                    pass
                    
        return truncated
    
    def cleanup_container_logs(self, max_size_mb: int = 50) -> dict:
        """Truncate Docker container logs if running in container"""
        result = {"truncated": [], "errors": []}
        
        # Check if we're in a container by checking /proc/1/cgroup
        if not Path("/proc/1/cgroup").exists():
            return result
            
        try:
            import subprocess
            # Get this container's log path
            container_id = subprocess.check_output(
                ["cat", "/proc/self/cgroup"],
                text=True
            ).split(":")[-1].strip()
            
            # Read container's log path from docker inspect
            log_path = subprocess.check_output(
                ["docker", "inspect", "--format={{.LogPath}}", container_id],
                text=True
            ).strip()
            
            if log_path and Path(log_path).exists():
                size_mb = Path(log_path).stat().st_size / 1024 / 1024
                if size_mb > max_size_mb:
                    with open(log_path, 'w') as f:
                        f.write("")
                    result["truncated"].append(log_path)
                    
        except Exception as e:
            result["errors"].append(str(e))
            
        return result
    
    def _get_size(self, path: Path) -> int:
        """Get size of file or directory"""
        try:
            if path.is_file():
                return path.stat().st_size
            elif path.is_dir():
                return sum(f.stat().st_size for f in path.rglob('*') if f.is_file())
        except:
            pass
        return 0
    
    def health_report(self) -> dict:
        """Generate cleanup health report"""
        return {
            "timestamp": datetime.now().isoformat(),
            "workspace_mb": self._get_size(self.workspace) / 1024 / 1024,
            "temp_mb": sum(self._get_size(Path(d)) for d in self.temp_dirs if Path(d).exists()) / 1024 / 1024
        }


async def periodic_cleanup(interval_minutes: int = 30):
    """Run cleanup periodically"""
    cleanup = ContainerCleanup()
    
    while True:
        try:
            result = cleanup.cleanup_temp_files()
            logger.info(f"Cleanup done: {result}")
        except Exception as e:
            logger.error(f"Cleanup error: {e}")
            
        await asyncio.sleep(interval_minutes * 60)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Container cleanup tool")
    parser.add_argument("--once", action="store_true", help="Run cleanup once and exit")
    parser.add_argument("--interval", type=int, default=30, help="Cleanup interval in minutes (for daemon mode)")
    parser.add_argument("--report", action="store_true", help="Show health report")
    
    args = parser.parse_args()
    
    cleanup = ContainerCleanup()
    
    if args.report:
        import json
        print(json.dumps(cleanup.health_report(), indent=2))
    elif args.once:
        result = cleanup.cleanup_temp_files()
        print(f"Deleted {result['deleted']} items, freed {result['freed_mb']:.2f} MB")
        truncated = cleanup.truncate_large_logs()
        print(f"Truncated {len(truncated)} log files")
    else:
        asyncio.run(periodic_cleanup(args.interval))
