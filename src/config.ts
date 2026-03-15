import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_HAS_OWN_NUMBER', 'LINE_IMAGE_PUBLIC_BASE_URL']);

export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive per-group assistant identity from trigger.
 * '@Maria' → 'Maria' | 'main' → 'Main' | 'family-chat' → 'Family Chat'
 */
export function getGroupAssistantName(group: { trigger?: string; folder: string }): string {
  const t = group.trigger?.trim();
  if (t?.startsWith('@') && t.length > 1) {
    return t.slice(1); // '@Maria' → 'Maria'
  }
  if (t && t.length > 0) {
    return t; // raw trigger word used as name
  }
  // Fallback: capitalize folder name
  return group.folder
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Generate per-group trigger pattern.
 * '@Maria' → /^@Maria\b/i
 */
export function getGroupTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger)}\\b`, 'i');
}

// Public HTTPS base URL for serving image files to LINE (e.g. ngrok URL)
// Must point to the same server as LINE_WEBHOOK_PORT (port 3000)
// Example: "https://abc123.ngrok-free.app"
export const LINE_IMAGE_PUBLIC_BASE_URL =
  process.env.LINE_IMAGE_PUBLIC_BASE_URL ||
  envConfig.LINE_IMAGE_PUBLIC_BASE_URL ||
  '';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const AGENT_CONFIG = {
  // ล็อกให้ใช้ Haiku 4.5 เท่านั้น (ประหยัดที่สุด)
  model: 'claude-3-haiku-20240307',

  // ตั้งค่า Token Limit เพื่อกันงบบานปลายต่อครั้ง
  max_tokens: 1000,

  // เปิดใช้งาน Prompt Caching (ถ้า SDK รองรับ) เพื่อลดค่า Token In 90%
  enable_caching: true,
};
