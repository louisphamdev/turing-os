/**
 * Audit Logger - Structured logging for all gateway requests
 * 
 * Logs every request to the gateway proxy for security auditing,
 * debugging, and compliance purposes. All sensitive data is sanitized.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Role, Permission } from '../rbac';
import { getAuditStore } from '../security/audit-store';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  workerId: string;
  role: Role;
  tokenId: string;
  service: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github';
  method: string;
  requestHeaders: Record<string, string>;
  requestBody?: any;
  responseStatus: number;
  responseBody?: any;
  duration: number;       // milliseconds
  error?: string;
}

export interface LLMEntry {
  id: string;
  timestamp: Date;
  workerId: string;
  role: Role;
  tokenId: string;
  provider: string;
  model: string;
  endpoint: string;
  requestBody?: any;
  responseStatus?: number;
  responseBody?: any;
  duration?: number;
  error?: string;
}

export interface ServiceEntry {
  id: string;
  timestamp: Date;
  workerId: string;
  role: Role;
  tokenId: string;
  service: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github';
  method: string;
  requestBody?: any;
  responseStatus?: number;
  responseBody?: any;
  duration?: number;
  error?: string;
}

const SENSITIVE_FIELDS = [
  'api_key', 'apikey', 'apiKey',
  'token', 'access_token', 'refresh_token',
  'password', 'secret', 'authorization',
  'llm_api_key', 'plane_api_token', 'bookstack_token',
  'matrix_bot_token', 'github_token',
  'bearer', 'key',
];

export class AuditLogger {
  private static instance: AuditLogger;
  private logDir: string;
  private currentLogFile: string;
  private maxFileSize: number = 10 * 1024 * 1024; // 10MB per file
  private buffer: AuditEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.logDir = path.join(process.cwd(), 'audit-logs');
    this.ensureLogDir();
    
    // Rotate to new file daily or when size exceeded
    this.currentLogFile = this.getLogFilename();
    
    // Flush buffer every 5 seconds
    this.flushInterval = setInterval(() => this.flush(), 5000);
    
    console.log(`[AuditLogger] Logging to ${this.logDir}`);
  }

  public static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  /**
   * Log a general gateway audit entry
   */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const fullEntry: AuditEntry = {
      ...entry,
      id: this.generateId(),
      timestamp: new Date(),
      requestBody: this.sanitizeBody(entry.requestBody),
      responseBody: this.truncateResponse(entry.responseBody),
    };

    this.buffer.push(fullEntry);

    // Mirror to Redis so audit history survives orchestrator restarts and
    // can be queried via /webhooks/audit/gateway.
    getAuditStore()
      .record('gateway', {
        id: fullEntry.id,
        workerId: fullEntry.workerId,
        role: fullEntry.role,
        tokenId: fullEntry.tokenId,
        service: fullEntry.service,
        method: fullEntry.method,
        responseStatus: fullEntry.responseStatus,
        duration: fullEntry.duration,
        error: fullEntry.error,
      })
      .catch(() => undefined);

    // Log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[AUDIT] ${fullEntry.service.toUpperCase()} ${fullEntry.method} - ${fullEntry.workerId} (${fullEntry.role}) - ${fullEntry.duration}ms`);
    }
  }

  /**
   * Log an LLM-specific entry
   */
  logLLMRequest(entry: Omit<LLMEntry, 'id' | 'timestamp'>): void {
    const fullEntry: LLMEntry = {
      ...entry,
      id: this.generateId(),
      timestamp: new Date(),
      requestBody: this.sanitizeBody(entry.requestBody),
      responseBody: this.truncateResponse(entry.responseBody),
    };
    
    // Also add to main audit log
    this.buffer.push({
      id: fullEntry.id,
      timestamp: fullEntry.timestamp,
      workerId: fullEntry.workerId,
      role: fullEntry.role,
      tokenId: fullEntry.tokenId,
      service: 'llm',
      method: fullEntry.endpoint,
      requestHeaders: {},
      requestBody: fullEntry.requestBody,
      responseStatus: fullEntry.responseStatus || 0,
      responseBody: fullEntry.responseBody,
      duration: fullEntry.duration || 0,
      error: fullEntry.error,
    });
  }

  /**
   * Log a service request entry
   */
  logServiceRequest(entry: Omit<ServiceEntry, 'id' | 'timestamp'>): void {
    const fullEntry: ServiceEntry = {
      ...entry,
      id: this.generateId(),
      timestamp: new Date(),
      requestBody: this.sanitizeBody(entry.requestBody),
      responseBody: this.truncateResponse(entry.responseBody),
    };
    
    // Also add to main audit log
    this.buffer.push({
      id: fullEntry.id,
      timestamp: fullEntry.timestamp,
      workerId: fullEntry.workerId,
      role: fullEntry.role,
      tokenId: fullEntry.tokenId,
      service: fullEntry.service,
      method: fullEntry.method,
      requestHeaders: {},
      requestBody: fullEntry.requestBody,
      responseStatus: fullEntry.responseStatus || 0,
      responseBody: fullEntry.responseBody,
      duration: fullEntry.duration || 0,
      error: fullEntry.error,
    });
  }

  /**
   * Search audit logs
   */
  async search(query: {
    workerId?: string;
    role?: Role;
    service?: string;
    startDate?: Date;
    endDate?: Date;
    method?: string;
    limit?: number;
  }): Promise<AuditEntry[]> {
    const results: AuditEntry[] = [];
    const files = this.getLogFiles();
    
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as AuditEntry;
            
            if (query.workerId && entry.workerId !== query.workerId) continue;
            if (query.role && entry.role !== query.role) continue;
            if (query.service && entry.service !== query.service) continue;
            if (query.method && !entry.method.includes(query.method)) continue;
            if (query.startDate && new Date(entry.timestamp) < query.startDate) continue;
            if (query.endDate && new Date(entry.timestamp) > query.endDate) continue;
            
            results.push(entry);
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
    
    // Sort by timestamp descending
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    return results.slice(0, query.limit || 100);
  }

  /**
   * Get audit statistics
   */
  async getStats(startDate?: Date, endDate?: Date): Promise<{
    totalRequests: number;
    byService: Record<string, number>;
    byRole: Record<string, number>;
    avgDuration: number;
    errorCount: number;
  }> {
    const entries = await this.search({ startDate, endDate, limit: 10000 });
    
    const stats = {
      totalRequests: entries.length,
      byService: {} as Record<string, number>,
      byRole: {} as Record<string, number>,
      avgDuration: 0,
      errorCount: 0,
    };
    
    let totalDuration = 0;
    
    for (const entry of entries) {
      stats.byService[entry.service] = (stats.byService[entry.service] || 0) + 1;
      stats.byRole[entry.role] = (stats.byRole[entry.role] || 0) + 1;
      totalDuration += entry.duration;
      
      if (entry.error || entry.responseStatus >= 400) {
        stats.errorCount++;
      }
    }
    
    stats.avgDuration = entries.length > 0 ? totalDuration / entries.length : 0;
    
    return stats;
  }

  /**
   * Flush buffer to disk
   */
  private flush(): void {
    if (this.buffer.length === 0) return;
    
    try {
      // Check file size
      const stats = fs.existsSync(this.currentLogFile) 
        ? fs.statSync(this.currentLogFile) 
        : null;
      
      if (stats && stats.size > this.maxFileSize) {
        this.currentLogFile = this.getLogFilename();
      }
      
      const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(this.currentLogFile, lines);
      
      this.buffer = [];
    } catch (error) {
      console.error('[AuditLogger] Flush error:', error);
    }
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Generate log filename with date
   */
  private getLogFilename(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${date}.jsonl`);
  }

  /**
   * Get all log files
   */
  private getLogFiles(): string[] {
    try {
      return fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .map(f => path.join(this.logDir, f))
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Sanitize body by removing sensitive fields
   */
  private sanitizeBody(body: any): any {
    if (!body) return undefined;
    
    try {
      const sanitized = JSON.parse(JSON.stringify(body));
      this.removeSensitiveFields(sanitized);
      return sanitized;
    } catch {
      return '[Complex Body]';
    }
  }

  /**
   * Recursively remove sensitive fields
   */
  private removeSensitiveFields(obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_FIELDS.some(sf => key.toLowerCase().includes(sf.toLowerCase()))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        this.removeSensitiveFields(obj[key]);
      }
    }
  }

  /**
   * Truncate response for storage
   */
  private truncateResponse(body: any, maxSize: number = 1024): any {
    if (!body) return undefined;
    
    try {
      const str = JSON.stringify(body);
      if (str.length > maxSize) {
        return {
          _truncated: true,
          _originalSize: str.length,
          _preview: str.slice(0, maxSize) + '...[truncated]',
        };
      }
      return body;
    } catch {
      return '[Binary Content]';
    }
  }

  /**
   * Shutdown and flush remaining entries
   */
  shutdown(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flush();
    console.log('[AuditLogger] Shutdown complete');
  }
}
