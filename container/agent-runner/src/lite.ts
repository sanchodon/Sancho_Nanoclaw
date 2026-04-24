/**
 * NanoClaw Lite Runner
 * Direct Anthropic Messages API — no Claude Code SDK overhead.
 * Input tokens: ~2-4K (vs ~30K for Agent SDK) → ~10 satang per message.
 *
 * Same stdin/stdout IPC protocol as index.ts.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const HISTORY_FILE = '/workspace/group/.lite-history.json';
const MAX_HISTORY_MESSAGES = 20; // 10 turns (user + assistant)

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const IMAGE_HASH_CACHE_FILE = '/workspace/group/.image-hashes.json';
const IMAGE_HASH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ImageHashEntry {
  hash: string;
  seenAt: number;
}

function loadImageHashes(): Map<string, number> {
  try {
    if (fs.existsSync(IMAGE_HASH_CACHE_FILE)) {
      const entries: ImageHashEntry[] = JSON.parse(fs.readFileSync(IMAGE_HASH_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      return new Map(entries.filter(e => now - e.seenAt < IMAGE_HASH_TTL_MS).map(e => [e.hash, e.seenAt]));
    }
  } catch { /* ignore */ }
  return new Map();
}

function saveImageHashes(hashes: Map<string, number>): void {
  try {
    const entries: ImageHashEntry[] = Array.from(hashes.entries()).map(([hash, seenAt]) => ({ hash, seenAt }));
    fs.writeFileSync(IMAGE_HASH_CACHE_FILE, JSON.stringify(entries));
  } catch { /* ignore */ }
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  useLiteMode?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type MessageParam = { role: 'user' | 'assistant'; content: string };

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(msg: string): void {
  console.error(`[lite-runner] ${msg}`);
}

function loadHistory(): MessageParam[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(messages: MessageParam[]): void {
  // Keep only the last MAX_HISTORY_MESSAGES to control token cost.
  // Strip image paths so subsequent calls don't re-encode the same image.
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES).map(m => ({
    ...m,
    content: m.content.replace(/\[image:\s*[^\]]+\]/g, '[receipt image]'),
  }));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed));
}

const SHARED_STATE_FILE = '/workspace/extra/shared/state.json';

function readSystemPrompt(): string {
  const claudeMd = '/workspace/group/CLAUDE.md';
  let prompt = fs.existsSync(claudeMd)
    ? fs.readFileSync(claudeMd, 'utf-8')
    : 'You are a helpful assistant.';

  // Inject any JSON data files listed in CLAUDE.md via [inject: filename.json] markers,
  // or auto-inject if a known data file exists alongside CLAUDE.md.
  const DATA_FILES = ['lottery_data.json'];
  for (const fname of DATA_FILES) {
    const fpath = `/workspace/group/${fname}`;
    if (fs.existsSync(fpath)) {
      try {
        const content = fs.readFileSync(fpath, 'utf-8');
        prompt += `\n\n---\n## CURRENT DATA: ${fname}\n\`\`\`json\n${content}\n\`\`\`\n---`;
        log(`Injected ${fname} into system prompt (${content.length} chars)`);
      } catch { /* ignore */ }
    }
  }

  // Inject daily_sales.xlsx (stored as CSV) so AI knows all recorded transactions
  const salesPath = '/workspace/group/daily_sales.xlsx';
  if (fs.existsSync(salesPath)) {
    try {
      const csvContent = fs.readFileSync(salesPath, 'utf-8');
      const rowCount = csvContent.split('\n').filter(l => l.trim()).length - 1;
      prompt += `\n\n---\n## ALL RECORDED TRANSACTIONS (daily_sales.xlsx — ${rowCount} rows)\nThis is the COMPLETE transaction history. Use this for ALL expense queries, totals, and reports — NOT your conversation memory.\n\`\`\`csv\n${csvContent}\n\`\`\`\n---`;
      log(`Injected daily_sales.xlsx (${csvContent.length} chars, ${rowCount} rows)`);
    } catch { /* ignore */ }
  }

  // Inject all files from shared folder (cross-group collaboration)
  const SHARED_DIR = '/workspace/extra/shared';
  const INJECTABLE_EXTENSIONS = ['.txt', '.json', '.md'];
  prompt += `\n\n---\n## SHARED FOLDER — already loaded, no tools needed\nThese files are shared with Maria and Nadia. You have already read them — reference this content directly in your replies without using any tools.\nTo write back, output: {"SHARED_WRITE":{"key":"value",...}}`;
  try {
    if (fs.existsSync(SHARED_DIR)) {
      const sharedFiles = fs.readdirSync(SHARED_DIR).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return INJECTABLE_EXTENSIONS.includes(ext) && !f.startsWith('.');
      });
      if (sharedFiles.length === 0) {
        prompt += `\nNo shared files yet.\n---`;
      } else {
        for (const fname of sharedFiles) {
          try {
            const content = fs.readFileSync(path.join(SHARED_DIR, fname), 'utf-8');
            prompt += `\n\n### ${fname}\n\`\`\`\n${content}\n\`\`\``;
            log(`Injected shared/${fname} (${content.length} chars)`);
          } catch { /* ignore */ }
        }
        prompt += `\n---`;
      }
    } else {
      prompt += `\nShared folder not mounted.\n---`;
    }
  } catch { prompt += `\n---`; }

  return prompt;
}

/**
 * Scan AI response for {"SHARED_WRITE":{...}} blocks and merge into shared state file.
 * Returns true if shared state was updated.
 */
function tryUpdateSharedState(response: string): boolean {
  const matches = Array.from(response.matchAll(/\{"SHARED_WRITE"\s*:\s*(\{[\s\S]*?\})\}/g));
  if (matches.length === 0) return false;

  // Load existing state
  let state: Record<string, unknown> = {};
  try {
    if (fs.existsSync(SHARED_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, 'utf-8'));
    }
  } catch { /* start fresh */ }

  let updated = false;
  for (const m of matches) {
    try {
      const patch = JSON.parse(m[1]) as Record<string, unknown>;
      Object.assign(state, patch);
      updated = true;
    } catch { /* invalid JSON — skip */ }
  }

  if (updated) {
    try {
      fs.mkdirSync(path.dirname(SHARED_STATE_FILE), { recursive: true });
      const tmp = SHARED_STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, SHARED_STATE_FILE);
      log(`Shared state updated: ${JSON.stringify(state).slice(0, 100)}`);
    } catch (err) {
      log(`Failed to write shared state: ${err}`);
      return false;
    }
  }
  return updated;
}

/**
 * After an assistant response, scan for a ```json ... ``` block that looks like
 * lottery data and write it back to lottery_data.json automatically.
 */
function tryAutoSaveJsonData(response: string): void {
  const DATA_FILE = '/workspace/group/lottery_data.json';
  const matches = Array.from(response.matchAll(/```json\s*([\s\S]*?)```/g));
  if (matches.length === 0) return;
  // Use the last JSON block (most likely to be the updated state)
  const lastJson = matches[matches.length - 1][1].trim();
  try {
    const parsed = JSON.parse(lastJson);
    // Only save if it looks like lottery data (has numbers array or phase field)
    if (Array.isArray(parsed.numbers) || typeof parsed.phase === 'number') {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
      fs.renameSync(tmp, DATA_FILE);
      log(`Auto-saved lottery_data.json update`);
    }
  } catch { /* not valid JSON or not lottery data — ignore */ }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const SALES_FILE = '/workspace/group/daily_sales.xlsx';

/**
 * Append a transaction row to daily_sales.xlsx (CSV format).
 * Returns true on success.
 */
function appendSaleRecord(date: string, category: string, amount: number, description: string): boolean {
  try {
    const row = `${date},${category},${amount.toFixed(2)},${description}\n`;
    // Create file with header if it doesn't exist
    if (!fs.existsSync(SALES_FILE)) {
      fs.writeFileSync(SALES_FILE, 'Date,Category,Amount,Description\n');
    }
    fs.appendFileSync(SALES_FILE, row);
    log(`Recorded: ${date} ${category} ฿${amount} — ${description}`);
    return true;
  } catch (err) {
    log(`Failed to record transaction: ${err}`);
    return false;
  }
}

/**
 * Scan AI response for {"ACTION":"RECORD",...} blocks and execute them.
 * Returns true if at least one transaction was recorded.
 */
function tryRecordTransaction(response: string): boolean {
  const matches = Array.from(response.matchAll(/\{[^{}]*"ACTION"\s*:\s*"RECORD"[^{}]*\}/g));
  if (matches.length === 0) return false;

  let recorded = false;
  for (const m of matches) {
    try {
      const obj = JSON.parse(m[0]) as { ACTION: string; date?: string; category?: string; amount?: number; description?: string };
      if (obj.ACTION !== 'RECORD') continue;
      const date = (obj.date || new Date().toISOString().slice(0, 10)).trim();
      const category = (obj.category || 'Other').trim();
      const amount = typeof obj.amount === 'number' ? obj.amount : parseFloat(String(obj.amount || 0));
      const description = (obj.description || '').trim();
      if (amount > 0 && appendSaleRecord(date, category, amount, description)) {
        recorded = true;
      }
    } catch { /* invalid JSON — skip */ }
  }
  return recorded;
}

/**
 * Convert a message string into content blocks.
 * Detects [image: /path] patterns and embeds them as base64 image blocks.
 * MD5-based deduplication skips images already seen in the last 24h.
 *
 * Returns content blocks AND a list of new image hashes (NOT yet saved —
 * caller should save them only after the transaction is actually recorded).
 */
function buildContentBlocks(
  text: string,
  hashCache: Map<string, number>,
): { content: ContentBlock[] | string; pendingHashes: string[] } {
  const IMAGE_RE = /\[image:\s*([^\]]+)\]/g;
  if (!IMAGE_RE.test(text)) return { content: text, pendingHashes: [] };

  const blocks: ContentBlock[] = [];
  const pendingHashes: string[] = [];
  let lastIndex = 0;
  IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMAGE_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) blocks.push({ type: 'text', text: before });

    const imagePath = match[1].trim();
    try {
      const data = fs.readFileSync(imagePath);
      const hash = crypto.createHash('md5').update(data).digest('hex');

      if (hashCache.has(hash)) {
        log(`Duplicate image: ${imagePath} (hash ${hash.slice(0, 8)}...)`);
        blocks.push({ type: 'text', text: '[duplicate receipt - already recorded]' });
      } else {
        pendingHashes.push(hash); // will be committed after successful recording
        const ext = path.extname(imagePath).toLowerCase();
        const media_type =
          ext === '.png' ? 'image/png' :
          ext === '.gif' ? 'image/gif' :
          ext === '.webp' ? 'image/webp' :
          'image/jpeg';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type, data: data.toString('base64') },
        });
        log(`Embedded image: ${imagePath} (${data.length} bytes, hash ${hash.slice(0, 8)}...)`);
      }
    } catch (err) {
      log(`Failed to read image ${imagePath}: ${err}`);
      blocks.push({ type: 'text', text: `[image not found: ${imagePath}]` });
    }

    lastIndex = IMAGE_RE.lastIndex;
  }

  const after = text.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', text: after });

  return { content: blocks.length > 0 ? blocks : text, pendingHashes };
}

async function callAnthropicAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: MessageParam[],
  hashCache: Map<string, number>,
): Promise<{ text: string; pendingHashes: string[] }> {
  // Build API messages, converting image paths to base64 blocks.
  // Collect pending hashes (saved only after successful recording).
  const allPendingHashes: string[] = [];
  const apiMessages = messages.map(m => {
    const { content, pendingHashes } = buildContentBlocks(m.content, hashCache);
    allPendingHashes.push(...pendingHashes);
    return { role: m.role, content };
  });

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: apiMessages,
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  };

  // Retry with backoff — Apple Container VM network may not be ready immediately
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = [2000, 4000, 8000, 16000, 30000];
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS[attempt - 1] ?? 30000;
      log(`Retry ${attempt}/${MAX_RETRIES} in ${delay}ms (${lastError?.message})`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errText}`);
      }
      const data = await response.json() as { content: { type: string; text?: string }[] };
      const text = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('');
      return { text, pendingHashes: allPendingHashes };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on network errors, not API errors
      if (!lastError.message.includes('fetch failed') && !lastError.message.includes('ENOTFOUND') && !lastError.message.includes('EAI_AGAIN')) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error('Max retries exceeded');
}

async function runTurn(
  prompt: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
): Promise<void> {
  const history = loadHistory();
  const hashCache = loadImageHashes();
  // Store original text in history (not base64) to keep history file small
  history.push({ role: 'user', content: prompt });

  try {
    const { text, pendingHashes } = await callAnthropicAPI(apiKey, model, systemPrompt, history, hashCache);
    history.push({ role: 'assistant', content: text });
    saveHistory(history);
    tryAutoSaveJsonData(text);

    // Record transactions if the AI output an ACTION:RECORD block.
    // Only save image hashes after successful recording (prevents "duplicate" false-positives
    // when the AI asks for clarification and hasn't recorded yet).
    const recorded = tryRecordTransaction(text);
    if (recorded && pendingHashes.length > 0) {
      const now = Date.now();
      for (const h of pendingHashes) hashCache.set(h, now);
      saveImageHashes(hashCache);
      log(`Saved ${pendingHashes.length} image hash(es) after recording`);
    }

    tryUpdateSharedState(text);

    // Strip action blocks from the user-facing response
    const userText = text
      .replace(/\{[^{}]*"ACTION"\s*:\s*"RECORD"[^{}]*\}/g, '')
      .replace(/\{"SHARED_WRITE"\s*:\s*\{[\s\S]*?\}\}/g, '')
      .trim();
    log(`Response: ${userText.slice(0, 100)}...`);
    writeOutput({ status: 'success', result: userText || null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`API error: ${msg}`);
    writeOutput({ status: 'error', result: null, error: msg });
  }
}

const PIE_KEYWORDS = ['pie', 'chart', 'graph', 'กราฟ', 'วงกลม'];
const EXCEL_KEYWORDS = ['excel', 'xlsx', 'export', 'ไฟล์ excel', 'ไฟล์excel', 'รายงาน excel', 'download excel', 'ดาวน์โหลด excel'];
const DAILY_REPORT_KEYWORD = 'daily-report';

function isDailyReportRequest(text: string): boolean {
  return text.toLowerCase().includes(DAILY_REPORT_KEYWORD);
}

function isPieChartRequest(text: string): boolean {
  const lower = extractUserText(text).toLowerCase();
  return PIE_KEYWORDS.some(kw => lower.includes(kw));
}

function isExcelRequest(text: string): boolean {
  const lower = extractUserText(text).toLowerCase();
  return EXCEL_KEYWORDS.some(kw => lower.includes(kw));
}

function extractUserText(text: string): string {
  // Pull only the text content from <message>...</message> tags (strips XML timestamps)
  const matches = Array.from(text.matchAll(/<message[^>]*>([^<]*)<\/message>/g));
  if (matches.length > 0) return matches.map(m => m[1]).join(' ');
  return text;
}

function extractMonthFilter(text: string): string | null {
  const userText = extractUserText(text);
  // Only match YYYY-MM in user-typed text, not in XML timestamps
  const m = userText.match(/\d{4}-\d{2}/);
  if (m) return m[0];
  const monthMap: Record<string, string> = {
    'january': '01', 'jan': '01', 'มกราคม': '01',
    'february': '02', 'feb': '02', 'กุมภาพันธ์': '02',
    'march': '03', 'mar': '03', 'มีนาคม': '03',
    'april': '04', 'apr': '04', 'เมษายน': '04',
    'may': '05', 'พฤษภาคม': '05',
    'june': '06', 'jun': '06', 'มิถุนายน': '06',
    'july': '07', 'jul': '07', 'กรกฎาคม': '07',
    'august': '08', 'aug': '08', 'สิงหาคม': '08',
    'september': '09', 'sep': '09', 'กันยายน': '09',
    'october': '10', 'oct': '10', 'ตุลาคม': '10',
    'november': '11', 'nov': '11', 'พฤศจิกายน': '11',
    'december': '12', 'dec': '12', 'ธันวาคม': '12',
  };
  const lower = userText.toLowerCase();
  for (const [name, num] of Object.entries(monthMap)) {
    if (lower.includes(name)) {
      return `${new Date().getFullYear()}-${num}`;
    }
  }
  // No month specified → all time
  return null;
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

function handleChartRequest(prompt: string, containerInput: ContainerInput): boolean {
  const xlsxPath = '/workspace/group/daily_sales.xlsx';
  const chartScript = '/workspace/group/chart_gen.py';
  const messagesDir = '/workspace/ipc/messages';

  if (!fs.existsSync(xlsxPath) || !fs.existsSync(chartScript)) {
    writeOutput({ status: 'success', result: 'ยังไม่มีข้อมูลรายจ่ายครับ Krub' });
    return true;
  }

  const month = extractMonthFilter(prompt);
  log(`chart request: prompt="${prompt.slice(0, 100)}" month="${month}"`);

  // chart_gen.py reads xlsx directly via pandas — no node/xlsx dependency
  const args = [chartScript];
  if (month) args.push(month);

  const chartResult = spawnSync('python3', args, { encoding: 'utf-8', timeout: 20000 });
  const output = (chartResult.stdout || '').trim();

  log(`chart_gen output: ${output}, stderr: ${(chartResult.stderr || '').slice(0, 200)}`);

  if (output === 'OK') {
    writeIpcFile(messagesDir, {
      type: 'file',
      chatJid: containerInput.chatJid,
      containerPath: '/workspace/group/summary.png',
      caption: `📊 รายจ่าย ${month || 'ทั้งหมด'} Krub`,
      mimeType: 'image/png',
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    });
    writeOutput({ status: 'success', result: null });
  } else if (output === 'NO_DATA' || output === 'ALL_ITEMS_NEED_REVIEW') {
    writeOutput({ status: 'success', result: `ยังไม่มีรายจ่ายที่จัดหมวดหมู่สำหรับ ${month} ครับ Krub` });
  } else {
    writeOutput({ status: 'success', result: `สร้างกราฟไม่ได้ครับ: ${output || chartResult.stderr?.slice(0, 100)} Krub` });
  }
  return true;
}

async function handleDailyReport(containerInput: ContainerInput, apiKey: string, model: string): Promise<void> {
  const xlsxPath = '/workspace/group/daily_sales.xlsx';
  const chartScript = '/workspace/group/chart_gen.py';
  const messagesDir = '/workspace/ipc/messages';

  if (!fs.existsSync(xlsxPath)) {
    writeOutput({ status: 'success', result: 'ยังไม่มีข้อมูลรายจ่ายครับ Krub' });
    return;
  }

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);

  // 1. Generate pie chart for current month
  if (fs.existsSync(chartScript)) {
    const chartResult = spawnSync('python3', [chartScript, month], { encoding: 'utf-8', timeout: 20000 });
    const chartOutput = (chartResult.stdout || '').trim();
    log(`daily report chart: ${chartOutput}`);
    if (chartOutput === 'OK') {
      writeIpcFile(messagesDir, {
        type: 'file',
        chatJid: containerInput.chatJid,
        containerPath: '/workspace/group/summary.png',
        caption: `📊 รายจ่ายเดือน ${month} Krub`,
        mimeType: 'image/png',
        groupFolder: containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Generate text balance sheet via API
  const systemPrompt = readSystemPrompt();
  const history = loadHistory();
  const hashCache = loadImageHashes();
  const reportPrompt = `[SCHEDULED TASK - รายงานประจำวัน ${today}]

สรุปค่าใช้จ่ายประจำวันนี้ (${today}) และยอดรวมเดือนนี้ (${month}) แบ่งตาม 10 หมวดหมู่ พร้อมยอดคงเหลือ ตอบสั้นกระชับไม่เกิน 10 บรรทัด`;

  history.push({ role: 'user', content: reportPrompt });
  try {
    const { text } = await callAnthropicAPI(apiKey, model, systemPrompt, history, hashCache);
    history.push({ role: 'assistant', content: text });
    saveHistory(history);
    const userText = text
      .replace(/\{[^{}]*"ACTION"\s*:\s*"RECORD"[^{}]*\}/g, '')
      .replace(/\{"SHARED_WRITE"\s*:\s*\{[\s\S]*?\}\}/g, '')
      .trim();
    writeOutput({ status: 'success', result: userText || null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`daily report API error: ${msg}`);
    writeOutput({ status: 'success', result: null });
  }
}

function handleExcelRequest(prompt: string, containerInput: ContainerInput): void {
  const xlsxPath = '/workspace/group/daily_sales.xlsx';
  const messagesDir = '/workspace/ipc/messages';

  if (!fs.existsSync(xlsxPath)) {
    writeOutput({ status: 'success', result: 'ยังไม่มีข้อมูลรายจ่ายครับ Krub' });
    return;
  }

  const month = extractMonthFilter(prompt);
  const outputFile = month ? `report_${month}.xlsx` : 'report.xlsx';
  const outputPath = `/workspace/group/${outputFile}`;

  log(`excel request: month="${month}" output="${outputPath}"`);
  const result = spawnSync('node', ['/usr/local/bin/export-report', '--output', outputPath, ...(month ? ['--month', month] : [])], {
    encoding: 'utf-8',
    timeout: 20000,
    env: { ...process.env, NODE_PATH: '/usr/local/lib/node_modules' },
  });
  const stdout = (result.stdout || '').trim();
  log(`export-report output: ${stdout}, stderr: ${(result.stderr || '').slice(0, 200)}`);

  if (stdout.startsWith('OK')) {
    writeIpcFile(messagesDir, {
      type: 'file',
      chatJid: containerInput.chatJid,
      containerPath: outputPath,
      caption: `📊 รายงาน Excel ${month || 'ทั้งหมด'} Krub`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    });
    writeOutput({ status: 'success', result: null });
  } else if (stdout === 'NO_DATA') {
    writeOutput({ status: 'success', result: 'ยังไม่มีข้อมูลรายจ่ายครับ Krub' });
  } else {
    writeOutput({ status: 'success', result: `สร้างไฟล์ Excel ไม่ได้ครับ: ${stdout || result.stderr?.slice(0, 100)} Krub` });
  }
}

export async function runLite(containerInput: ContainerInput): Promise<void> {
  const apiKey = containerInput.secrets?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'No ANTHROPIC_API_KEY found' });
    return;
  }

  const model = containerInput.model || 'claude-haiku-4-5-20251001';

  log(`Lite mode: model=${model}`);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Drain any pending IPC messages into initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // Main loop: process message → wait for next → repeat
  while (true) {
    // Re-read system prompt each turn so data file injections (e.g. lottery_data.json)
    // reflect the latest state written by the previous turn.
    const systemPrompt = readSystemPrompt();
    if (isDailyReportRequest(prompt)) {
      await handleDailyReport(containerInput, apiKey, model);
    } else if (isPieChartRequest(prompt)) {
      handleChartRequest(prompt, containerInput);
    } else if (isExcelRequest(prompt)) {
      handleExcelRequest(prompt, containerInput);
    } else {
      await runTurn(prompt, apiKey, model, systemPrompt);
    }

    // Emit session-update marker (keeps host idle timer running)
    writeOutput({ status: 'success', result: null });

    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      break;
    }
    prompt = nextMessage;
  }
}
