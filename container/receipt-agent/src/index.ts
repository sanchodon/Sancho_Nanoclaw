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
Critical - DATE EXTRACTION (IMPORTANT FOR THAI RECEIPTS):
For Thai dates in Buddhist calendar (BE), convert to Gregorian:
- Thai months: มค=01, กพ=02, มีค=03, เมย=04, พค=05, มิย=06, กค=07, สค=08, กย=09, ตค=10, พย=11, ธค=12
- If year is 2-digit (69, 26) and >2000 in Buddhist: subtract 543 to get Gregorian year
  Example: "03 เม.ย. 69" = day 3, month 04, year 69 (BE) = 3 April 2026 → "2026-04-03"
- English dates just use as-is (YYYY-MM-DD)
- If date ambiguous: report as "UNKNOWN" (don't guess)
Critical - MEMO EXTRACTION RULES:
Priority 1 - Extract from these labels: บันทึก, ปันทึก, สาขา, ประเภท, ชนิด, รายการ, หมวดหมู่ (NOT transaction ID fields)
Priority 2 - Extract category keywords: Food, Drink, Coffee, Travel, Rent, Salary, Utility, Supply, Marketing, Tax, Personal
Priority 3 - Extract Thai category words: อาหาร, เครื่องดื่ม, การเดินทาง, ค่าเช่า, ค่าแรง, ค่าน้ำไฟ, อุปกรณ์, การตลาด, ภาษี, ส่วนตัว
Priority 4 - Extract merchant name if no explicit category found (e.g., restaurant name, hotel name)
SKIP: Transaction IDs, reference numbers, serial numbers - these are NOT memos
Examples: "สาขา: Food" → memo="Food" | "ประเภท: อาหาร" → memo="อาหาร" | "Bangkok Transfer" → null (not a category)
- Ref.No: Extract from receipt if visible
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
      model: 'claude-3-haiku-20240307',
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
