import crypto from 'crypto';
import { execSync as execSyncFn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  getGroupAssistantName,
  getGroupTriggerPattern,
} from './config.js';
import { LineChannel } from './channels/line.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  migrateTimestampCursor,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Load API key from .env for receipt processing
const envVars = readEnvFile(['ANTHROPIC_API_KEY']);
const ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY;

// Track recently processed receipts for duplicate detection (last 20)
interface ProcessedReceipt {
  date: string;
  name?: string;
  amount: number;
  type?: string;
  timestamp: number;
  ref_no?: string; // Unique reference number from receipt
}
let recentReceipts: ProcessedReceipt[] = [];
let processedRefNumbers = new Set<string>(); // Track reference numbers to prevent re-processing

// Track pending receipts waiting for memo confirmation
interface PendingReceipt {
  date: string;
  amount: number;
  name?: string;
  timestamp: number;
  memo?: string;
  ref_no?: string;
  type?: string;
}
let pendingReceiptForMemo: PendingReceipt | null = null;
let pendingReceiptTimestamp = 0;

// Track pending category selections (user needs to respond with 1-10)
// Support multiple receipts waiting for category at the same time
interface PendingCategorySelection {
  receipt: PendingReceipt;
  requestedAt: number;
}
let pendingCategorySelections: PendingCategorySelection[] = [];

let lastProcessedMemoContent = ''; // Track memo texts already processed to avoid sending to agent
let processedMemos = new Set<string>(); // Track ALL memos processed in this batch (cross-poll + image extraction)

// Batching buffer for receipts (3-second window to collect multiple images before processing)
interface PendingBatchReceipt {
  filePath: string;
  imageMediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  memoText: string;
  timestamp: number;
}
let receiptBatchBuffer: Map<string, PendingBatchReceipt[]> = new Map(); // chatJid -> array of pending receipts
let batchTimers: Map<string, NodeJS.Timeout> = new Map(); // chatJid -> timeout ID for batch processing

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  const rawTimestamp = getRouterState('last_timestamp') || '';
  lastTimestamp = migrateTimestampCursor(rawTimestamp);
  if (lastTimestamp !== rawTimestamp) {
    logger.info({ from: rawTimestamp, to: lastTimestamp }, 'Migrated last_timestamp cursor to rowid');
  }

  const agentTs = getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs ? JSON.parse(agentTs) : {};
    // Migrate any ISO timestamp cursors to rowid cursors
    lastAgentTimestamp = {};
    for (const [jid, cursor] of Object.entries(parsed)) {
      const migrated = migrateTimestampCursor(cursor as string);
      if (migrated !== cursor) {
        logger.info({ jid, from: cursor, to: migrated }, 'Migrated lastAgentTimestamp cursor to rowid');
      }
      lastAgentTimestamp[jid] = migrated;
    }
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Extract numeric category selections from user response.
 * Supports: pure numbers (1-10), comma-separated (2,1,7), or mixed with text (2, 1, 7 do you understand)
 * Returns array of categories or empty array if no valid selections found
 */
function extractNumericResponseCategories(response: string): string[] {
  const trimmed = response.trim();
  const categoryMap: Record<number, string> = {
    1: '#อาหาร',
    2: '#เครื่องดื่ม',
    3: '#การเดินทาง',
    4: '#ค่าเช่า',
    5: '#ค่าแรง',
    6: '#ค่าน้ำไฟ',
    7: '#อุปกรณ์',
    8: '#การตลาด',
    9: '#ภาษี',
    10: '#ส่วนตัว',
  };

  const categories: string[] = [];

  // Extract all numbers from the message
  const numberPattern = /\d+/g;
  const matches = trimmed.match(numberPattern);

  if (matches) {
    for (const match of matches) {
      const num = parseInt(match, 10);
      if (num >= 1 && num <= 10) {
        const category = categoryMap[num];
        if (category) {
          categories.push(category);
        }
      }
    }
  }

  return categories;
}

/**
 * Get Thai category name with emoji for display
 */
function getCategoryDisplay(category: string): string {
  const categoryMap: Record<string, string> = {
    '#อาหาร': '🍽️ #อาหาร (Food)',
    '#เครื่องดื่ม': '☕ #เครื่องดื่ม (Drink)',
    '#การเดินทาง': '🚕 #การเดินทาง (Travel)',
    '#ค่าเช่า': '🏠 #ค่าเช่า (Rental)',
    '#ค่าแรง': '💼 #ค่าแรง (Wage)',
    '#ค่าน้ำไฟ': '⚡ #ค่าน้ำไฟ (Utility)',
    '#อุปกรณ์': '📦 #อุปกรณ์ (Supply)',
    '#การตลาด': '📢 #การตลาด (Marketing)',
    '#ภาษี': '📊 #ภาษี (Tax)',
    '#ส่วนตัว': '👤 #ส่วนตัว (Personal)',
  };
  return categoryMap[category] || category;
}

/**
 * Get category selection menu in Thai
 */
function getCategoryMenu(): string {
  return `กรุณาเลือกหมวดหมู่ครับ:
1️⃣ 🍽️ #อาหาร (Food)
2️⃣ ☕ #เครื่องดื่ม (Drink)
3️⃣ 🚕 #การเดินทาง (Travel)
4️⃣ 🏠 #ค่าเช่า (Rental)
5️⃣ 💼 #ค่าแรง (Wage)
6️⃣ ⚡ #ค่าน้ำไฟ (Utility)
7️⃣ 📦 #อุปกรณ์ (Supply)
8️⃣ 📢 #การตลาด (Marketing)
9️⃣ 📊 #ภาษี (Tax)
🔟 👤 #ส่วนตัว (Personal)`;
}

/**
 * Extract and process receipts from image messages in the main group.
 * Returns true if at least one receipt was processed.
 */
async function processReceiptsFromMessages(
  missedMessages: ReturnType<typeof getMessagesSince>,
  groupFolder: string,
  channel: any,
  chatJid: string,
): Promise<boolean> {
  if (groupFolder !== MAIN_GROUP_FOLDER) return false;

  if (!ANTHROPIC_API_KEY) {
    logger.warn(
      'ANTHROPIC_API_KEY not found in .env, skipping receipt processing',
    );
    return false;
  }

  let processedAny = false;

  logger.info(
    {
      messageCount: missedMessages.length,
      messages: missedMessages.map((m) => ({
        sender: m.sender_name,
        preview: m.content.substring(0, 50),
      })),
    },
    'Processing receipts - checking message order',
  );

  // Check if first message is a short text that could be memo for pending receipt
  if (pendingReceiptForMemo && missedMessages.length > 0) {
    const firstMsg = missedMessages[0];
    const timeSinceReceipt = Date.now() - pendingReceiptTimestamp;

    // If first message is text-only and arrives within 2 minutes of receipt
    if (!firstMsg.content.match(/\[image:/) && timeSinceReceipt < 120000) {
      const textContent = firstMsg.content.trim();
      const isShort = textContent.length < 100; // Short text likely memo
      const isNotCommand =
        !textContent.startsWith('@') && !textContent.startsWith('/'); // Not a command

      // SKIP if it's a numeric category selection (1-10, comma-separated, or mixed) — let numeric handler deal with it
      const isNumericResponse =
        extractNumericResponseCategories(textContent).length > 0;

      if (
        isShort &&
        isNotCommand &&
        textContent.length > 0 &&
        !isNumericResponse
      ) {
        logger.info(
          { text: textContent, pendingReceipt: pendingReceiptForMemo },
          '✅ Found potential memo for pending receipt',
        );

        // Check if memo matches any keyword
        const keywordMap = [
          {
            words: ['กิน', 'อาหาร', 'ข้าว', 'food', 'eat', 'ร้าน', 'shop'],
            category: '#อาหาร',
          },
          {
            words: ['น้ำ', 'กาแฟ', 'coffee', 'drink', 'cafe', 'ชา', 'tea'],
            category: '#เครื่องดื่ม',
          },
          {
            words: [
              'รถ',
              'น้ำมัน',
              'gas',
              'taxi',
              'travel',
              'ที่จอด',
              'parking',
            ],
            category: '#การเดินทาง',
          },
          {
            words: ['เช่า', 'หอ', 'ห้อง', 'rent', 'room', 'receipt', 'บ้าน'],
            category: '#ค่าเช่า',
          },
          {
            words: [
              'แรง',
              'เงินเดือน',
              'จ้าง',
              'wage',
              'salary',
              'นาย',
              'นาง',
              'น.ส.',
              'staff',
            ],
            category: '#ค่าแรง',
          },
          {
            words: [
              'ไฟ',
              'เน็ต',
              'bill',
              'utility',
              'mea',
              'ประเมา',
              'true',
              'ais',
            ],
            category: '#ค่าน้ำไฟ',
          },
          {
            words: [
              'ของ',
              'ซื้อ',
              'วัสดุ',
              'supply',
              'stock',
              'equipment',
              'tool',
            ],
            category: '#อุปกรณ์',
          },
          {
            words: [
              'โฆษณา',
              'เพจ',
              'ad',
              'ads',
              'marketing',
              'facebook',
              'google',
            ],
            category: '#การตลาด',
          },
          {
            words: ['ภาษี', 'tax', 'vat', 'sso', 'ประกันสังคม'],
            category: '#ภาษี',
          },
          {
            words: [
              'ส่วนตัว',
              'ใช้เอง',
              'personal',
              'gift',
              'ของขวัญ',
              'wallet',
            ],
            category: '#ส่วนตัว',
          },
        ];

        let matchedKeyword = '';
        // Remove common prefixes
        let cleanedText = textContent
          .toLowerCase()
          .replace(/^บันทึก\s*/i, '')
          .replace(/^memo:\s*/i, '')
          .replace(/^note:\s*/i, '')
          .trim();

        const textLower = cleanedText;
        for (const group of keywordMap) {
          for (const word of group.words) {
            if (
              textLower.startsWith(word.toLowerCase()) ||
              textLower.includes(' ' + word.toLowerCase())
            ) {
              matchedKeyword = word;
              break;
            }
          }
          if (matchedKeyword) break;
        }

        if (!matchedKeyword) {
          logger.warn(
            { memo: textContent, receipt: pendingReceiptForMemo },
            '⚠️ NAME SAFETY: Memo for pending receipt has no keyword match',
          );
          // Get the channel to send message
          const channel = findChannel(channels, chatJid);
          if (channel && pendingReceiptForMemo) {
            await channel.sendMessage(
              chatJid,
              `✓ ฿${pendingReceiptForMemo.amount} expense | ${pendingReceiptForMemo.date}\n🔖 บันทึก: "${textContent}"\n\n💰 เลือกหมวดหมู่ครับ:\n1️⃣ #อาหาร\n2️⃣ #เครื่องดื่ม\n3️⃣ #การเดินทาง\n4️⃣ #ค่าเช่า\n5️⃣ #ค่าแรง\n6️⃣ #ค่าน้ำไฟ\n7️⃣ #อุปกรณ์\n8️⃣ #การตลาด\n9️⃣ #ภาษี\n🔟 #ส่วนตัว`,
            );
            // Add to pending category selections so next numeric response gets intercepted
            pendingCategorySelections.push({
              receipt: pendingReceiptForMemo,
              requestedAt: Date.now(),
            });
          }
        } else {
          // Keyword matched in cross-poll! Send confirmation with category
          logger.info(
            {
              memo: textContent,
              matchedKeyword,
              receipt: pendingReceiptForMemo,
            },
            '✅ CROSS-POLL: Keyword matched - Auto-recording',
          );
          const channel = findChannel(channels, chatJid);
          if (channel && pendingReceiptForMemo) {
            // Find which category this keyword belongs to
            let matchedCategory = '';
            const keywordMap = [
              {
                words: ['กิน', 'อาหาร', 'ข้าว', 'food', 'eat', 'ร้าน', 'shop'],
                category: '#อาหาร',
              },
              {
                words: ['น้ำ', 'กาแฟ', 'coffee', 'drink', 'cafe', 'ชา', 'tea'],
                category: '#เครื่องดื่ม',
              },
              {
                words: [
                  'รถ',
                  'น้ำมัน',
                  'gas',
                  'taxi',
                  'travel',
                  'ที่จอด',
                  'parking',
                ],
                category: '#การเดินทาง',
              },
              {
                words: [
                  'เช่า',
                  'หอ',
                  'ห้อง',
                  'rent',
                  'room',
                  'receipt',
                  'บ้าน',
                ],
                category: '#ค่าเช่า',
              },
              {
                words: [
                  'แรง',
                  'เงินเดือน',
                  'จ้าง',
                  'wage',
                  'salary',
                  'นาย',
                  'นาง',
                  'น.ส.',
                  'staff',
                ],
                category: '#ค่าแรง',
              },
              {
                words: [
                  'ไฟ',
                  'เน็ต',
                  'bill',
                  'utility',
                  'mea',
                  'ประเมา',
                  'true',
                  'ais',
                ],
                category: '#ค่าน้ำไฟ',
              },
              {
                words: [
                  'ของ',
                  'ซื้อ',
                  'วัสดุ',
                  'supply',
                  'stock',
                  'equipment',
                  'tool',
                ],
                category: '#อุปกรณ์',
              },
              {
                words: [
                  'โฆษณา',
                  'เพจ',
                  'ad',
                  'ads',
                  'marketing',
                  'facebook',
                  'google',
                ],
                category: '#การตลาด',
              },
              {
                words: ['ภาษี', 'tax', 'vat', 'sso', 'ประกันสังคม'],
                category: '#ภาษี',
              },
              {
                words: [
                  'ส่วนตัว',
                  'ใช้เอง',
                  'personal',
                  'gift',
                  'ของขวัญ',
                  'wallet',
                ],
                category: '#ส่วนตัว',
              },
            ];
            for (const group of keywordMap) {
              if (group.words.includes(matchedKeyword)) {
                matchedCategory = group.category;
                break;
              }
            }
            const categoryDisplay = getCategoryDisplay(matchedCategory);
            const confirmation = `✓ ฿${pendingReceiptForMemo.amount} expense | ${pendingReceiptForMemo.date}\n${categoryDisplay} Krub.`;
            await channel.sendMessage(chatJid, confirmation);
          }
        }
        // Mark this memo as processed so it doesn't get sent to main agent
        lastProcessedMemoContent = textContent;
        processedMemos.add(textContent); // Track in current batch
        pendingReceiptForMemo = null; // Clear pending memo receipt
        // Note: Don't clear pendingCategorySelections here - it may have other receipts waiting
        // Those will be processed as user sends numeric responses (1-10)
      }
    }
  }

  // BATCHING: Collect all images first, process with 3-second delay to batch multiple receipts
  const imagesToProcess: PendingBatchReceipt[] = [];

  for (let i = 0; i < missedMessages.length; i++) {
    const msg = missedMessages[i];

    // Detect image message: formatted as "[image: /workspace/group/images/...]"
    const imageMatch = msg.content.match(/\[image: (.+?)\]/);
    if (!imageMatch) continue;

    // Extract memo/caption from message (text around or near the image)
    let memoText = msg.content.replace(/\[image: .+?\]/g, '').trim();

    // If no caption with image, check next message for memo (if it's text-only)
    if (!memoText && i + 1 < missedMessages.length) {
      const nextMsg = missedMessages[i + 1];
      // If next message is text-only (no image), treat as memo
      if (!nextMsg.content.match(/\[image:/)) {
        memoText = nextMsg.content.trim();
        logger.info({ memo: memoText }, 'Memo extracted from next message');
        processedMemos.add(memoText); // Mark this memo as processed in current batch
      }
    }

    const imagePath = imageMatch[1];
    const filePath = path.join(
      GROUPS_DIR,
      groupFolder,
      imagePath.slice('/workspace/group/'.length),
    );
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'Receipt image file not found');
      continue;
    }

    // Detect media type from file extension
    const ext = path.extname(filePath).toLowerCase();
    const mediaTypeMap: Record<
      string,
      'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    > = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const imageMediaType = mediaTypeMap[ext] || 'image/jpeg';

    // Add to batch buffer instead of processing immediately
    imagesToProcess.push({
      filePath,
      imageMediaType,
      memoText,
      timestamp: Date.now(),
    });
  }

  // If we collected images, add them to the batch buffer and schedule processing
  if (imagesToProcess.length > 0) {
    const existing = receiptBatchBuffer.get(chatJid) || [];
    receiptBatchBuffer.set(chatJid, [...existing, ...imagesToProcess]);

    logger.info(
      { chatJid, newImages: imagesToProcess.length, totalInBatch: receiptBatchBuffer.get(chatJid)!.length },
      'Images added to batch buffer, scheduling batch processing',
    );

    // Cancel existing timer if any (restart the 3-second window)
    const existingTimer = batchTimers.get(chatJid);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule batch processing after 3 seconds
    const newTimer = setTimeout(() => {
      processBatchReceipts(chatJid, channel, groupFolder).catch((err) =>
        logger.error({ err, chatJid }, 'Error processing receipt batch'),
      );
      batchTimers.delete(chatJid);
    }, 3000);

    batchTimers.set(chatJid, newTimer);

    // Early return — batch will be processed after 3-second window
    return processedAny;
  }

  return processedAny;
}

/**
 * Process a batch of collected receipts.
 * Called after 3-second buffer window to batch multiple receipts into single processing cycle.
 * Sends one consolidated reply summarizing all results.
 */
async function processBatchReceipts(
  chatJid: string,
  channel: Channel,
  groupFolder: string,
): Promise<void> {
  const batch = receiptBatchBuffer.get(chatJid);
  if (!batch || batch.length === 0) return;

  receiptBatchBuffer.delete(chatJid);

  logger.info(
    { chatJid, batchSize: batch.length },
    'Processing batched receipts',
  );

  const results: { success: boolean; amount?: number; date?: string; memo?: string; category?: string; error?: string }[] = [];
  let processedCount = 0;

  for (const pendingReceipt of batch) {
    try {
      // Read image as base64
      const imageBuffer = fs.readFileSync(pendingReceipt.filePath);
      const imageBase64 = imageBuffer.toString('base64');

      logger.info({ filePath: pendingReceipt.filePath }, 'Processing receipt from batch');

      try {
        // Spawn receipt agent container
        const { exec } = await import('child_process');
        const result = await new Promise<any>((resolve, reject) => {
          const input = JSON.stringify({
            imageBase64,
            imageMediaType: pendingReceipt.imageMediaType,
          });

          const child = exec(
            `container run -i --rm -e ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' nanoclaw-receipt-agent:latest`,
            { maxBuffer: 1024 * 1024 * 10 },
            (error, stdout, stderr) => {
              if (error) {
                reject(new Error(`Receipt agent error: ${error.message}`));
                return;
              }
              if (stderr) {
                logger.debug({ stderr }, 'Receipt agent stderr');
              }
              try {
                resolve(JSON.parse(stdout));
              } catch {
                reject(new Error(`Invalid JSON from receipt agent: ${stdout}`));
              }
            },
          );

          child.stdin?.write(input);
          child.stdin?.end();
        });

        if (result.success && result.date && result.amount) {
          // Validate date
          let validatedDate = result.date;
          const extractedYear = parseInt(result.date.split('-')[0], 10);
          const currentYear = new Date().getFullYear();

          if (Math.abs(extractedYear - currentYear) > 1) {
            const now = new Date();
            const y = now.getFullYear();
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const d = String(now.getDate()).padStart(2, '0');
            validatedDate = `${y}-${m}-${d}`;
          }

          // Get memo (prefer extracted from image, then from message)
          let memoText = result.memo || pendingReceipt.memoText;

          // Check for keyword match
          const keywordMap = [
            { words: ['กิน', 'อาหาร', 'ข้าว', 'food', 'eat', 'ร้าน', 'shop'], category: '#อาหาร' },
            { words: ['น้ำ', 'กาแฟ', 'coffee', 'drink', 'cafe', 'ชา', 'tea'], category: '#เครื่องดื่ม' },
            { words: ['รถ', 'น้ำมัน', 'gas', 'taxi', 'travel', 'ที่จอด', 'parking'], category: '#การเดินทาง' },
            { words: ['เช่า', 'หอ', 'ห้อง', 'rent', 'room', 'receipt', 'บ้าน'], category: '#ค่าเช่า' },
            { words: ['แรง', 'เงินเดือน', 'จ้าง', 'wage', 'salary', 'นาย', 'นาง', 'น.ส.', 'staff'], category: '#ค่าแรง' },
            { words: ['ไฟ', 'เน็ต', 'bill', 'utility', 'mea', 'ประเมา', 'true', 'ais'], category: '#ค่าน้ำไฟ' },
            { words: ['ของ', 'ซื้อ', 'วัสดุ', 'supply', 'stock', 'equipment', 'tool'], category: '#อุปกรณ์' },
            { words: ['โฆษณา', 'เพจ', 'ad', 'ads', 'marketing', 'facebook', 'google'], category: '#การตลาด' },
            { words: ['ภาษี', 'tax', 'vat', 'sso', 'ประกันสังคม'], category: '#ภาษี' },
            { words: ['ส่วนตัว', 'ใช้เอง', 'personal', 'gift', 'ของขวัญ', 'wallet'], category: '#ส่วนตัว' },
          ];

          let matchedCategory = '';
          if (memoText) {
            const cleanedMemo = memoText.toLowerCase().replace(/^บันทึก\s*/i, '').trim();
            for (const group of keywordMap) {
              for (const word of group.words) {
                if (cleanedMemo.startsWith(word.toLowerCase()) || cleanedMemo.includes(' ' + word.toLowerCase())) {
                  matchedCategory = group.category;
                  break;
                }
              }
              if (matchedCategory) break;
            }
          }

          // Check duplicate
          let isDuplicate = false;
          if (result.ref_no && processedRefNumbers.has(result.ref_no)) {
            isDuplicate = true;
          } else if (!result.ref_no) {
            const recentMatch = recentReceipts.find((r) =>
              r.date === validatedDate && Math.abs(r.amount - result.amount) === 0 &&
              r.timestamp > Date.now() - 3600000
            );
            isDuplicate = !!recentMatch;
          }

          if (isDuplicate) {
            results.push({
              success: false,
              amount: result.amount,
              date: validatedDate,
              error: '🔴 บันทึกซ้ำแล้ว',
            });
          } else {
            // Record receipt
            recentReceipts.push({
              date: validatedDate,
              name: result.name,
              amount: result.amount,
              type: result.type,
              timestamp: Date.now(),
              ref_no: result.ref_no,
            });
            if (result.ref_no) processedRefNumbers.add(result.ref_no);
            if (recentReceipts.length > 20) {
              const removed = recentReceipts.shift();
              if (removed?.ref_no) processedRefNumbers.delete(removed.ref_no);
            }

            if (matchedCategory) {
              results.push({
                success: true,
                amount: result.amount,
                date: validatedDate,
                category: matchedCategory,
              });
              processedCount++;
            } else {
              // Store for category confirmation
              const receipt: PendingReceipt = {
                date: validatedDate,
                amount: result.amount,
                name: result.name,
                timestamp: Date.now(),
                memo: memoText,
                ref_no: result.ref_no,
                type: result.type,
              };
              pendingCategorySelections.push({
                receipt,
                requestedAt: Date.now(),
              });
              results.push({
                success: true,
                amount: result.amount,
                date: validatedDate,
                memo: memoText,
              });
            }
          }
        } else {
          results.push({
            success: false,
            error: result.error || '⚠️ อ่านสลิปไม่ได้',
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          success: false,
          error: errorMsg,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMsg }, 'Batch receipt error');
      results.push({
        success: false,
        error: errorMsg,
      });
    }
  }

  // Send consolidated reply with all results
  if (results.length > 0) {
    let summary = '📋 ผลการประมวลผลสลิป:\n\n';
    let autoRecorded = 0, pendingReview = 0, failed = 0;

    for (const result of results) {
      if (!result.success) {
        failed++;
        summary += `❌ ${result.error}\n`;
      } else if (result.category) {
        autoRecorded++;
        summary += `✓ ฿${result.amount} | ${result.date} ${result.category}\n`;
      } else {
        pendingReview++;
        summary += `⏳ ฿${result.amount} | ${result.date} | "${result.memo}"\n`;
      }
    }

    summary += `\n📊 สรุป: ✓ ${autoRecorded} | ⏳ ${pendingReview} | ❌ ${failed}`;
    if (pendingReview > 0) {
      summary += `\n\n${getCategoryMenu()}`;
    }

    await channel.sendMessage(chatJid, summary);
  }

  logger.info(
    { chatJid, batchSize: batch.length, processedCount },
    'Batch processing complete',
  );
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 * This function recursively processes batches of messages until caught up,
 * ensuring no gaps in message flow while waiting for user responses.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  let missedMessages = getMessagesSince(chatJid, sinceTimestamp);

  if (missedMessages.length === 0) return true;

  // Process this batch, then check for any new messages that arrived during processing
  const success = await processMessageBatch(chatJid, group, channel, isMainGroup, missedMessages);

  if (success) {
    // After processing a batch, immediately check if new messages arrived
    // This prevents gaps where receipts sent during processing wait for next poll cycle.
    // Only recurse if the cursor actually advanced — otherwise processMessageBatch returned
    // early (e.g. no trigger match) and we'd loop forever on the same messages.
    const nowSinceTimestamp = lastAgentTimestamp[chatJid] || '';
    if (nowSinceTimestamp !== sinceTimestamp) {
      const newMessages = getMessagesSince(chatJid, nowSinceTimestamp);
      if (newMessages.length > 0) {
        logger.debug(
          { chatJid, newMessageCount: newMessages.length },
          'New messages arrived during processing, processing immediately',
        );
        return processGroupMessages(chatJid);
      }
    }
  }

  return success;
}

/**
 * Save image hashes for a set of messages to the group's dedup hash file.
 * Called both from processMessageBatch (normal path) and the piping path in
 * startMessageLoop so that piped images are tracked for future duplicate detection.
 */
function saveImageHashesForMessages(messages: NewMessage[], groupFolder: string): void {
  const hashFile = path.join(resolveGroupFolderPath(groupFolder), '.processed-image-hashes.json');
  let processedHashes: string[] = [];
  try { processedHashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8')); } catch { /* no file yet */ }

  const newHashes: string[] = [];
  for (const m of messages) {
    const match = m.content.match(/\[image:\s*([^\]]+)\]/);
    if (!match) continue;
    const imagePath = match[1].trim().replace('/workspace/group', resolveGroupFolderPath(groupFolder));
    try {
      const hash = crypto.createHash('md5').update(fs.readFileSync(imagePath)).digest('hex');
      if (!processedHashes.includes(hash) && !newHashes.includes(hash)) {
        newHashes.push(hash);
      }
    } catch { /* file unreadable — skip */ }
  }

  if (newHashes.length > 0) {
    const updated = [...processedHashes, ...newHashes].slice(-200);
    try { fs.writeFileSync(hashFile, JSON.stringify(updated)); } catch { /* ignore */ }
    logger.debug({ groupFolder, count: newHashes.length }, 'Saved image hashes for future dedup');
  }
}

/**
 * Process a single batch of messages.
 * Extracted from processGroupMessages to support recursive processing.
 */
async function processMessageBatch(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
  isMainGroup: boolean,
  missedMessages: NewMessage[],
): Promise<boolean> {

  // For receipts in main group: try to extract before sending to main agent
  const receiptsProcessed = await processReceiptsFromMessages(
    missedMessages,
    group.folder,
    channel,
    chatJid,
  );

  // Filter out image messages - they've been handled by receipt agent
  // Exception: lite runner groups (useLiteRunner) pass images directly to the agent
  const useLiteRunner = group.containerConfig?.useLiteRunner === true;

  // For lite runner groups: deduplicate images by MD5 before sending to agent
  // This prevents paying for duplicate base64 image tokens (~4-8K tokens per image)
  const originalMissedMessages = missedMessages;
  if (useLiteRunner) {
    const hashFile = path.join(resolveGroupFolderPath(group.folder), '.processed-image-hashes.json');
    let processedHashes: string[] = [];
    try { processedHashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8')); } catch { /* no file yet */ }

    const deduped = missedMessages.filter((m) => {
      const match = m.content.match(/\[image:\s*([^\]]+)\]/);
      if (!match) return true; // Not an image message — always keep
      const imagePath = match[1].trim().replace('/workspace/group', resolveGroupFolderPath(group.folder));
      try {
        const hash = crypto.createHash('md5').update(fs.readFileSync(imagePath)).digest('hex');
        if (processedHashes.includes(hash)) {
          logger.info({ group: group.name, imagePath }, 'Duplicate image — skipping (already processed)');
          return false;
        }
        // Resize image to 400px wide to reduce base64 token cost (~6x fewer tokens)
        try {
          execSyncFn(`sips --resampleWidth 400 "${imagePath}" 2>/dev/null`, { timeout: 5000 });
        } catch { /* resize failed — use original */ }
        return true;
      } catch { return true; } // Can't read file — let it through
    });

    // Persist hashes for all new (non-duplicate) images
    saveImageHashesForMessages(deduped, group.folder);

    missedMessages = deduped;
  }

  // Notify about duplicates (partial or full) and handle fully-duplicate batches
  if (useLiteRunner) {
    const dupCount = originalMissedMessages.filter(m => m.content.match(/\[image:/)).length
      - missedMessages.filter(m => m.content.match(/\[image:/)).length;

    if (dupCount > 0 && channel) {
      await channel.sendMessage(
        chatJid,
        `⚠️ พบสลิปซ้ำ ${dupCount} รายการ — ข้ามการบันทึกครับ Krub.`,
      );
    }

    // If ALL images were duplicates, nothing left to process
    if (missedMessages.length === 0 && originalMissedMessages.length > 0) {
      lastAgentTimestamp[chatJid] =
        String(originalMissedMessages[originalMissedMessages.length - 1].rowid!);
      saveState();
      logger.info({ group: group.name }, 'All images were duplicates — skipping agent call');
      return true;
    }
  }

  // Lite runner groups: all messages including images (handled inline by lite.ts buildContentBlocks)
  // Full agent groups (Maria, Nadia, etc.): also pass images — Claude Code SDK handles them natively
  // Only exception: receipt-only batching groups filter images out earlier via processReceiptsFromMessages
  let nonImageMessages = missedMessages;

  // Filter out memo messages that were already processed (cross-poll + image extraction)
  if (processedMemos.size > 0) {
    nonImageMessages = nonImageMessages.filter(
      (m) => !processedMemos.has(m.content.trim()),
    );
  }
  // Reset tracking for next batch
  processedMemos.clear();
  lastProcessedMemoContent = '';

  // Handle numeric category selection responses (user sent 1-10, comma-separated, or mixed with text)
  // Works in any group/DM, not just main group
  let categorizedReceiptsForSancho: Array<{
    receipt: PendingReceipt;
    category: string;
  }> = [];

  if (pendingCategorySelections.length > 0 && nonImageMessages.length > 0) {
    const firstMsg = nonImageMessages[0];
    const responseText = firstMsg.content.trim();
    const selectedCategories = extractNumericResponseCategories(responseText);

    if (selectedCategories.length > 0) {
      logger.info(
        { categoriesCount: selectedCategories.length, pending: pendingCategorySelections.length },
        '✅ User sent category selections',
      );

      // Process each selected category in order
      for (const selectedCategory of selectedCategories) {
        if (pendingCategorySelections.length === 0) {
          logger.warn(
            { extraCategories: selectedCategories.length - categorizedReceiptsForSancho.length },
            '⚠️ More category selections than pending receipts',
          );
          break;
        }

        // Process the next pending category selection
        const pending = pendingCategorySelections.shift()!; // Remove from queue
        const receipt = pending.receipt;

        logger.info(
          { amount: receipt.amount, category: selectedCategory },
          '✅ Categorized receipt from user selection',
        );

        // Send confirmation to user
        const categoryDisplay = getCategoryDisplay(selectedCategory);
        const confirmation = `✓ ฿${receipt.amount} expense | ${receipt.date}\n${categoryDisplay} Krub.`;

        if (channel) {
          await channel.sendMessage(chatJid, confirmation);
        }

        // Save the categorized receipt to forward to Sancho
        categorizedReceiptsForSancho.push({
          receipt,
          category: selectedCategory,
        });
      }

      // Mark the numeric response as processed (don't send to Sancho)
      processedMemos.add(responseText);
      nonImageMessages = nonImageMessages.filter(
        (m) => m.timestamp !== firstMsg.timestamp,
      );
    }
  }

  // If we have categorized receipts, add them as synthetic messages for Sancho to record
  if (categorizedReceiptsForSancho.length > 0 && nonImageMessages.length === 0) {
    for (const cr of categorizedReceiptsForSancho) {
      const r = cr.receipt;
      const categoryName = cr.category.replace('#', '');
      // Format as transaction message Sancho understands
      const transactionMessage = `[Receipt] ฿${r.amount} | ${r.date} | ${categoryName}${r.memo ? ` | ${r.memo}` : ''}${r.name ? ` | To: ${r.name}` : ''}`;
      const syntheticId = `synthetic-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      nonImageMessages.push({
        id: syntheticId,
        chat_jid: chatJid,
        sender: 'user',
        sender_name: 'User',
        timestamp: new Date().toISOString(),
        is_from_me: false,
        content: transactionMessage,
      });
      logger.info(
        { amount: r.amount, category: cr.category },
        'Forwarding categorized receipt to Sancho for recording',
      );
    }
  }

  // If only image messages were processed, mark cursor and return (skip main agent)
  // Lite runner groups always process messages (images included above)
  if (!useLiteRunner && nonImageMessages.length === 0) {
    lastAgentTimestamp[chatJid] =
      String(missedMessages[missedMessages.length - 1].rowid!);
    saveState();
    logger.info(
      { group: group.name },
      'Only receipt images, skipping main agent',
    );
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getGroupTriggerPattern(group.trigger || '');
    const hasTrigger = nonImageMessages.some((m) =>
      triggerPattern.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(nonImageMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    String(missedMessages[missedMessages.length - 1].rowid!);
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const assistantName = getGroupAssistantName(group);
  const output = await runAgent(
    group,
    prompt,
    chatJid,
    assistantName,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  assistantName: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('NanoClaw running');

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getGroupTriggerPattern(group.trigger || '');
            const hasTrigger = groupMessages.some((m) =>
              triggerPattern.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Save hashes for piped images so future batches can detect them as duplicates
            if (group.containerConfig?.useLiteRunner) {
              saveImageHashesForMessages(messagesToSend, group.folder);
            }
            lastAgentTimestamp[chatJid] =
              String(messagesToSend[messagesToSend.length - 1].rowid!);
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onAutoRegisterDM: (chatJid: string, lineChannelSecret: string) => {
      // Find the template group that owns this LINE sub-channel
      const template = Object.values(registeredGroups).find(
        (g) => g.containerConfig?.lineChannelSecret === lineChannelSecret,
      );
      if (!template) {
        logger.warn({ chatJid, lineChannelSecret }, 'No template group found for DM auto-registration');
        return;
      }
      // Generate an isolated folder name from the userId (e.g. maria-u774f16a)
      const userShort = chatJid.slice(0, 9).toLowerCase();
      const folder = `${template.folder}-${userShort}`;
      // Copy CLAUDE.md from template so persona is inherited
      const templateMd = path.join(GROUPS_DIR, template.folder, 'CLAUDE.md');
      const newGroupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(newGroupDir, { recursive: true });
      if (fs.existsSync(templateMd)) {
        fs.copyFileSync(templateMd, path.join(newGroupDir, 'CLAUDE.md'));
      }
      const newGroup: RegisteredGroup = {
        name: template.name,
        folder,
        trigger: template.trigger,
        added_at: new Date().toISOString(),
        containerConfig: template.containerConfig,
        requiresTrigger: false, // 1-on-1 DM: no trigger word needed
      };
      registerGroup(chatJid, newGroup);
      logger.info({ chatJid, folder, templateFolder: template.folder }, 'Auto-registered 1-on-1 DM');
    },
    onAutoRegisterGroup: (chatJid: string, lineChannelSecret: string) => {
      // Find the template group that owns this LINE sub-channel
      const template = Object.values(registeredGroups).find(
        (g) => g.containerConfig?.lineChannelSecret === lineChannelSecret,
      );
      if (!template) {
        logger.warn({ chatJid, lineChannelSecret }, 'No template group found for group auto-registration');
        return;
      }
      // Generate an isolated folder name from the group ID (e.g. nadia-ced01b891)
      const groupShort = chatJid.slice(0, 9).toLowerCase();
      const folder = `${template.folder}-${groupShort}`;
      // Copy CLAUDE.md from template so persona is inherited
      const templateMd = path.join(GROUPS_DIR, template.folder, 'CLAUDE.md');
      const newGroupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(newGroupDir, { recursive: true });
      if (fs.existsSync(templateMd)) {
        fs.copyFileSync(templateMd, path.join(newGroupDir, 'CLAUDE.md'));
      }
      const newGroup: RegisteredGroup = {
        name: template.name,
        folder,
        trigger: template.trigger,
        added_at: new Date().toISOString(),
        containerConfig: template.containerConfig,
        requiresTrigger: template.requiresTrigger,
      };
      registerGroup(chatJid, newGroup);
      logger.info({ chatJid, folder, templateFolder: template.folder }, 'Auto-registered LINE group');
    },
  };

  // Create and connect channels
  const line = new LineChannel(channelOpts);
  channels.push(line);
  await line.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: async (jid, hostPath, caption, mimeType) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel found for sendFile');
        return;
      }
      if (!channel.sendFile) {
        logger.warn(
          { jid, channel: channel.name },
          'Channel does not support sendFile',
        );
        return;
      }
      return channel.sendFile(jid, hostPath, caption, mimeType);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: () => Promise.resolve(), // LINE delivers group info via webhook events
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
