/**
 * NanoClaw Receipt Agent
 * Lightweight receipt extractor using Claude Haiku via Anthropic SDK
 * Reads JSON from stdin, outputs JSON to stdout
 */

import Anthropic from '@anthropic-ai/sdk';

interface ReceiptInput {
  imageBase64: string;
  imageMediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

interface ReceiptOutput {
  success: boolean;
  date?: string;
  name?: string;
  amount?: number;
  type?: 'income' | 'expense';
  ref_no?: string;
  memo?: string;
  error?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
    process.stdin.on('error', reject);
  });
}

function log(msg: string) {
  console.error(`[receipt-agent] ${msg}`);
}

const SYSTEM_PROMPT = `Extract receipt data from images. Return ONLY valid JSON with fields:
{
  "date": "YYYY-MM-DD or UNKNOWN if date is not clearly readable",
  "name": "who paid/received or null",
  "amount": 123.45 or null,
  "type": "income" or "expense" or null,
  "ref_no": "receipt reference number (Ref.No., Invoice#, Transaction ID, etc.) or null if not visible",
  "memo": "any category, description, or note - can be null"
}
CRITICAL - MEMO/CATEGORY EXTRACTION (MOST IMPORTANT):
Step 1: Scan entire receipt image for these EXACT Thai labels and read the TEXT IMMEDIATELY FOLLOWING:
- "บันทึก" (with or without colon) → extract the word/phrase after it
- "ปันทึก" (with or without colon) → extract the word/phrase after it
- "สาขา" (with or without colon) → extract the word/phrase after it
- "ประเภท" (with or without colon) → extract the word/phrase after it
- "ชนิด" (with or without colon) → extract the word/phrase after it
- "รายการ" (with or without colon) → extract the word/phrase after it
- "หมวดหมู่" (with or without colon) → extract the word/phrase after it
Step 2: If any of these labels found, EXTRACT THE FOLLOWING TEXT (even if it's in English like "Food")
Step 3: Only return null if genuinely no category/description label found
Examples: If receipt shows "ปันทึก Food" → memo="Food" | "ประเภท Salary" → memo="Salary"
IGNORE: Transaction IDs, reference numbers, merchant IDs, serial numbers - only extract category labels
DATE EXTRACTION (CRITICAL - MULTIPLE DATES ON RECEIPT):
Receipts have multiple dates. Extract TRANSACTION DATE ONLY (when money moved):
- Look for: "วันที่ เวลา", "Date Time", "Transaction Date" at TOP of receipt
- SKIP: Historical dates, reference numbers containing dates, posting dates from 2022
- Thai months: มค=01, กพ=02, มีค=03, เมย=04, พค=05, มิย=06, กค=07, สค=08, กย=09, ตค=10, พย=11, ธค=12
- 2-digit year (69, 26): subtract 543 to convert BE to Gregorian
- Example: "15 มี.ค. 69" = day 15, month 03, year 69 (BE) → "2026-03-15"
- USE: The date closest to top of receipt (that's the transaction date)
- IGNORE: Any date from 2022 or older if a recent date (2025, 2026) is visible
- Ref.No: Extract if visible
- No explanation text, JSON only.`;

async function processReceipt(input: ReceiptInput): Promise<ReceiptOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'ANTHROPIC_API_KEY environment variable not set',
    };
  }

  const client = new Anthropic({
    apiKey,
  });

  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.imageMediaType,
                data: input.imageBase64,
              },
            },
            {
              type: 'text',
              text: 'Extract this receipt data as JSON.',
            },
          ],
        },
      ],
    });

    const duration = Date.now() - startTime;

    // Extract text response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return {
        success: false,
        error: 'No text response from model',
        cost_usd: (response.usage.input_tokens * 0.80 + response.usage.output_tokens * 4) / 1000000,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };
    }

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(textContent.text);
    } catch {
      return {
        success: false,
        error: `Failed to parse response: ${textContent.text}`,
        cost_usd: (response.usage.input_tokens * 0.80 + response.usage.output_tokens * 4) / 1000000,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };
    }

    const costUsd = (response.usage.input_tokens * 0.80 + response.usage.output_tokens * 4) / 1000000;

    log(`✓ Processed in ${duration}ms | ${response.usage.input_tokens} in / ${response.usage.output_tokens} out | $${costUsd.toFixed(6)}`);

    return {
      success: true,
      date: result.date,
      name: result.name,
      amount: result.amount,
      type: result.type,
      ref_no: result.ref_no,
      memo: result.memo,
      cost_usd: costUsd,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

async function main() {
  try {
    const inputJson = await readStdin();
    const input = JSON.parse(inputJson) as ReceiptInput;
    const output = await processReceipt(input);
    console.log(JSON.stringify(output));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      success: false,
      error: `Fatal: ${errorMsg}`,
    }));
    process.exit(1);
  }
}

main();
