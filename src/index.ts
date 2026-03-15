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
}
let pendingReceiptForMemo: PendingReceipt | null = null;
let pendingReceiptTimestamp = 0;
let lastProcessedMemoContent = ''; // Track memo texts already processed to avoid sending to agent
let processedMemos = new Set<string>(); // Track ALL memos processed in this batch (cross-poll + image extraction)

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
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

      if (isShort && isNotCommand && textContent.length > 0) {
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
          if (channel) {
            await channel.sendMessage(
              chatJid,
              `⚠️ บันทึก: "${textContent}" แต่ไม่ตรงหมวด\n\nกรุณาเลือก:\n1️⃣ #อาหาร\n2️⃣ #ค่าแรง\n3️⃣ #ค่าเช่า\n4️⃣ #ค่าน้ำไฟ\n5️⃣ #ส่วนตัว\n6️⃣ #อื่นๆ`,
            );
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
        pendingReceiptForMemo = null; // Clear pending
      }
    }
  }

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

    // Read image as base64
    const imageBuffer = fs.readFileSync(filePath);
    const imageBase64 = imageBuffer.toString('base64');

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

    logger.info({ filePath }, 'Processing receipt image');

    try {
      // Spawn receipt agent container
      const { exec } = await import('child_process');
      const result = await new Promise<any>((resolve, reject) => {
        const input = JSON.stringify({ imageBase64, imageMediaType });

        const child = exec(
          `container run -i --rm -e ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' nanoclaw-receipt-agent:latest`,
          { maxBuffer: 1024 * 1024 * 10 }, // 10MB buffer
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
        // Validate extracted date against message timestamp
        let validatedDate = result.date;
        const messageDate = new Date(msg.timestamp);
        const messageYear = messageDate.getFullYear();
        const extractedYear = parseInt(result.date.split('-')[0], 10);

        // If extracted year is wildly off from current year, use message date instead
        if (Math.abs(extractedYear - messageYear) > 1) {
          logger.warn(
            {
              extractedDate: result.date,
              messageDate: msg.timestamp,
              messageYear,
            },
            '⚠️ DATE MISMATCH - Haiku extracted wrong year, using message timestamp',
          );
          // Use message date (YYYY-MM-DD format)
          const y = messageDate.getFullYear();
          const m = String(messageDate.getMonth() + 1).padStart(2, '0');
          const d = String(messageDate.getDate()).padStart(2, '0');
          validatedDate = `${y}-${m}-${d}`;
        }

        logger.info(
          {
            date: validatedDate,
            extractedDate: result.date,
            name: result.name,
            amount: result.amount,
            type: result.type,
            memo: memoText,
            costUsd: result.cost_usd,
          },
          'Receipt extracted successfully',
        );

        // Prioritize memo extracted from receipt image (from Haiku) over next message
        if (result.memo && result.memo.length > 0) {
          memoText = result.memo;
          logger.info(
            { memo: memoText },
            'Using memo extracted from receipt image',
          );
          processedMemos.add(memoText); // Mark as processed
        }

        // KEYWORD-FIRST MATCHING: Check if memo starts with recognized keyword
        const keywordMap = [
          // Food
          {
            words: ['กิน', 'อาหาร', 'ข้าว', 'food', 'eat', 'ร้าน', 'shop'],
            category: '#อาหาร',
          },
          // Drink
          {
            words: ['น้ำ', 'กาแฟ', 'coffee', 'drink', 'cafe', 'ชา', 'tea'],
            category: '#เครื่องดื่ม',
          },
          // Travel
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
          // Rental
          {
            words: ['เช่า', 'หอ', 'ห้อง', 'rent', 'room', 'receipt', 'บ้าน'],
            category: '#ค่าเช่า',
          },
          // Wage
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
          // Utility
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
          // Supply
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
          // Marketing
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
          // Tax
          {
            words: ['ภาษี', 'tax', 'vat', 'sso', 'ประกันสังคม'],
            category: '#ภาษี',
          },
          // Personal
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

        let keywordMatchedCategory = '';
        if (memoText && memoText.length > 0) {
          // Remove common prefixes like "บันทึก", "memo:", "note:" etc
          let cleanedMemo = memoText
            .toLowerCase()
            .replace(/^บันทึก\s*/i, '')
            .replace(/^memo:\s*/i, '')
            .replace(/^note:\s*/i, '')
            .trim();

          const memoLower = cleanedMemo;
          for (const group of keywordMap) {
            for (const word of group.words) {
              // Check if memo STARTS WITH or CONTAINS the keyword
              if (
                memoLower.startsWith(word.toLowerCase()) ||
                memoLower.includes(' ' + word.toLowerCase())
              ) {
                keywordMatchedCategory = group.category;
                break;
              }
            }
            if (keywordMatchedCategory) break;
          }
        }

        const hasMemoWithoutKeyword =
          memoText && memoText.length > 0 && !keywordMatchedCategory;

        // DUPLICATE CHECK using Ref. No. (the unique identifier from receipt data)
        logger.info(
          { refNo: result.ref_no, date: validatedDate, amount: result.amount },
          'Checking duplicates using Ref. No.',
        );

        let isDuplicate = false;
        let duplicationReason = '';

        // First: Check if Ref. No. is present and already processed
        if (result.ref_no) {
          if (processedRefNumbers.has(result.ref_no)) {
            isDuplicate = true;
            duplicationReason = `Ref. No. ${result.ref_no} already processed`;
          }
        } else {
          // If no Ref. No., fall back to date+amount check (EXACT match only - very strict)
          // Require EXACT amount match (no tolerance) to avoid false positives
          const recentMatch = recentReceipts.find((recent) => {
            const diff = Math.abs(recent.amount - result.amount);
            return (
              recent.date === validatedDate &&
              diff === 0 &&
              recent.timestamp > Date.now() - 3600000 // within last hour
            );
          });
          if (recentMatch) {
            isDuplicate = true;
            duplicationReason = `Exact date+amount match (no Ref. No. on receipt)`;
          }
        }

        if (isDuplicate) {
          logger.warn(
            {
              refNo: result.ref_no,
              date: validatedDate,
              amount: result.amount,
              reason: duplicationReason,
            },
            '🔴 DUPLICATE DETECTED',
          );
          await channel.sendMessage(
            chatJid,
            `🔴 ฿${result.amount} | ${result.date}\nบันทึกซ้ำแล้ว - ไม่บันทึก\n(${duplicationReason})`,
          );
        } else {
          // Record this receipt as processed
          recentReceipts.push({
            date: validatedDate,
            name: result.name,
            amount: result.amount,
            type: result.type,
            timestamp: Date.now(),
            ref_no: result.ref_no,
          });
          // Track reference number to prevent re-processing
          if (result.ref_no) {
            processedRefNumbers.add(result.ref_no);
          }
          logger.info(
            { recentCount: recentReceipts.length, refNo: result.ref_no },
            '✅ Receipt recorded in memory',
          );
          // Keep only last 20
          if (recentReceipts.length > 20) {
            const removed = recentReceipts.shift();
            if (removed?.ref_no) {
              processedRefNumbers.delete(removed.ref_no);
            }
          }

          // If keyword matched, record with category. Otherwise ask user
          if (keywordMatchedCategory) {
            logger.info(
              { memo: memoText, matchedCategory: keywordMatchedCategory },
              '✅ KEYWORD MATCHED - Auto-recording',
            );
            const categoryDisplay = getCategoryDisplay(keywordMatchedCategory);
            const confirmation = `✓ ฿${result.amount} expense | ${result.date}\n${categoryDisplay} Krub.`;
            await channel.sendMessage(chatJid, confirmation);
            processedAny = true;
          } else {
            // No keyword match - ask for category BEFORE recording
            logger.warn(
              { memo: memoText, amount: result.amount },
              '⚠️ No keyword match - asking for category',
            );

            // Show expense details + ask for category
            const memoDisplay = memoText
              ? `บันทึก: "${memoText}"`
              : 'ไม่มีบันทึก';
            const askMessage = `⚠️ ฿${result.amount} expense | ${result.date}\n${memoDisplay}\n\n${getCategoryMenu()}`;
            await channel.sendMessage(chatJid, askMessage);
            processedAny = true;

            // Store as pending receipt waiting for category response
            pendingReceiptForMemo = {
              date: validatedDate,
              amount: result.amount,
              name: result.name,
              timestamp: Date.now(),
            };
            pendingReceiptTimestamp = Date.now();
          }
        }
      } else {
        logger.info(
          { error: result.error },
          'Receipt extraction failed or incomplete',
        );
        if (result.error) {
          await channel.sendMessage(
            chatJid,
            `⚠️ อ่านสลิปไม่ได้ครับ: ${result.error}`,
          );
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMsg }, 'Receipt processing error');
      await channel.sendMessage(chatJid, `⚠️ เกิดข้อผิดพลาด: ${errorMsg}`);
    }
  }

  return processedAny;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
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
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp);

  if (missedMessages.length === 0) return true;

  // For receipts in main group: try to extract before sending to main agent
  const receiptsProcessed = await processReceiptsFromMessages(
    missedMessages,
    group.folder,
    channel,
    chatJid,
  );

  // Filter out image messages - they've been handled by receipt agent
  let nonImageMessages = missedMessages.filter(
    (m) => !m.content.match(/\[image:/),
  );

  // Filter out memo messages that were already processed (cross-poll + image extraction)
  if (processedMemos.size > 0) {
    nonImageMessages = nonImageMessages.filter(
      (m) => !processedMemos.has(m.content.trim()),
    );
  }
  // Reset tracking for next batch
  processedMemos.clear();
  lastProcessedMemoContent = '';

  // If only image messages were processed, mark cursor and return (skip main agent)
  if (nonImageMessages.length === 0) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
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
    missedMessages[missedMessages.length - 1].timestamp;
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
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
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
