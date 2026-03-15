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
  "memo": "any memo/note text written on receipt (บันทึก, note, memo, etc.) or null if not visible"
}
Critical:
- If you cannot read the date clearly, report it as "UNKNOWN" instead of guessing
- Extract Ref.No/Reference Number if visible (หมายเลขรายการ, เลขที่อ้างอิง, Ref No, Invoice#, etc.)
- Extract memo text if visible (บันทึก, หมายเหตุ, note, memo, etc.)
- For name and amount, use null if unclear
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
