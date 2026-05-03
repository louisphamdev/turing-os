/**
 * Agent Initialization — Loads role spec .md files for AI agents.
 * 
 * AI Agent roles (PO, PM, HR, Doctor) operate by loading their role spec files
 * which define their behavior, responsibilities, and system prompts.
 * These role specs are the "brains" of each agent — no additional code needed.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AgentRole {
  id: string;
  name: string;
  specPath: string;
  spec: string;
  systemPrompt: string;
  loaded: boolean;
}

// Role registry — maps role IDs to their loaded specs
const agentRoles: Map<string, AgentRole> = new Map();

// All role spec files under roles/
const ROLE_SPECS: Record<string, { name: string; file: string }> = {
  po:                { name: 'Product Owner',             file: 'po.md' },
  pm:                { name: 'Project Manager',           file: 'pm.md' },
  hr:                { name: 'HR Coordinator',            file: 'hr.md' },
  doctor:            { name: 'Doctor',                    file: 'doctor.md' },
  'software-engineer': { name: 'Software Engineer',      file: 'software-engineer.md' },
  ba:                { name: 'Business Analyst',          file: 'ba.md' },
  qa:                { name: 'QA Engineer',               file: 'qa.md' },
  devops:            { name: 'DevOps Engineer',           file: 'devops.md' },
  data:              { name: 'Data Engineer',             file: 'data.md' },
  security:          { name: 'Security Engineer',         file: 'security.md' },
  network:           { name: 'Network Engineer',          file: 'network.md' },
};

/**
 * Extract system prompt from role spec markdown.
 * Looks for content between "## System Prompt Context" and the next ## heading.
 */
function extractSystemPrompt(spec: string): string {
  const match = spec.match(/## System Prompt Context\s*\n```\n([\s\S]*?)\n```/);
  return match ? match[1].trim() : '';
}

/**
 * Load a single role spec file
 */
function loadRoleSpec(roleId: string, rolesDir: string): AgentRole | null {
  const roleDef = ROLE_SPECS[roleId];
  if (!roleDef) {
    console.warn(`[AgentInit] Unknown role: ${roleId}`);
    return null;
  }

  const specPath = path.join(rolesDir, roleDef.file);
  
  try {
    if (!fs.existsSync(specPath)) {
      console.warn(`[AgentInit] Role spec not found: ${specPath}`);
      return null;
    }

    const spec = fs.readFileSync(specPath, 'utf-8');
    const systemPrompt = extractSystemPrompt(spec);

    const role: AgentRole = {
      id: roleId,
      name: roleDef.name,
      specPath,
      spec,
      systemPrompt,
      loaded: true,
    };

    agentRoles.set(roleId, role);
    return role;
  } catch (error) {
    console.error(`[AgentInit] Failed to load ${roleDef.file}: ${error}`);
    return null;
  }
}

/**
 * Initialize all AI agent roles by loading their spec files.
 * Call this on orchestrator startup.
 */
export function initAgentRoles(rolesDir?: string): void {
  // Resolve roles directory — check multiple locations
  const possibleDirs = [
    rolesDir,
    path.join(process.cwd(), 'roles'),
    path.join(process.cwd(), '..', 'roles'),
    '/app/roles',
  ].filter(Boolean) as string[];

  let resolvedDir = '';
  for (const dir of possibleDirs) {
    if (fs.existsSync(dir)) {
      resolvedDir = dir;
      break;
    }
  }

  if (!resolvedDir) {
    console.warn('[AgentInit] ⚠ roles/ directory not found — agents will use fallback prompts');
    return;
  }

  console.log('[AgentInit] ═══════════════════════════════════════');
  console.log(`[AgentInit] Loading role specs from: ${resolvedDir}`);

  let loaded = 0;
  let failed = 0;

  for (const roleId of Object.keys(ROLE_SPECS)) {
    const role = loadRoleSpec(roleId, resolvedDir);
    if (role) {
      const promptLen = role.systemPrompt.length;
      console.log(`[AgentInit]  ✓ ${role.name} (${role.id}) — ${role.spec.length} chars, prompt: ${promptLen > 0 ? promptLen + ' chars' : '⚠ no prompt found'}`);
      loaded++;
    } else {
      console.log(`[AgentInit]  ✗ ${ROLE_SPECS[roleId].name} (${roleId}) — FAILED`);
      failed++;
    }
  }

  // Also try to load language and specialization files
  const langDir = path.join(resolvedDir, 'languages');
  const specDir = path.join(resolvedDir, 'specializations');
  let extras = 0;

  for (const subDir of [langDir, specDir]) {
    if (fs.existsSync(subDir)) {
      const files = fs.readdirSync(subDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
      extras += files.length;
    }
  }

  console.log(`[AgentInit] Loaded: ${loaded}/${Object.keys(ROLE_SPECS).length} roles, ${extras} language/specialization files`);
  if (failed > 0) {
    console.warn(`[AgentInit] ⚠ ${failed} role(s) failed to load`);
  }
  console.log('[AgentInit] ═══════════════════════════════════════');
}

/**
 * Get a loaded agent role by ID
 */
export function getAgentRole(roleId: string): AgentRole | undefined {
  return agentRoles.get(roleId);
}

/**
 * Get the system prompt for a specific role
 */
export function getSystemPrompt(roleId: string): string {
  const role = agentRoles.get(roleId);
  return role?.systemPrompt || '';
}

/**
 * Get all loaded agent roles
 */
export function getAllAgentRoles(): AgentRole[] {
  return Array.from(agentRoles.values());
}

/**
 * Get the full role spec content for injection into worker prompts
 */
export function getRoleSpec(roleId: string): string {
  const role = agentRoles.get(roleId);
  return role?.spec || '';
}
