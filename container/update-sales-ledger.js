#!/usr/bin/env node
// update-sales-ledger — append a confirmed sale to daily_sales.xlsx
// Usage: update-sales-ledger --date "2024-01-15" --name "Vendor Name" --amount "1500.00" [--type income|expense]
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] || '';
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { date, name, amount, type = 'income' } = args;

if (!date || !name || !amount) {
  console.error('Usage: update-sales-ledger --date "YYYY-MM-DD" --name "Name" --amount "0.00" [--type income|expense]');
  process.exit(1);
}

if (type !== 'income' && type !== 'expense') {
  console.error('--type must be "income" or "expense"');
  process.exit(1);
}

const xlsxPath = path.join('/workspace/group', 'daily_sales.xlsx');

const NEW_HEADER = ['Date', 'Name', 'Income (\u0e3f)', 'Expense (\u0e3f)'];

let wb;
let rows;

if (fs.existsSync(xlsxPath)) {
  wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Migrate old 3-column schema (Amount (฿)) to new 4-column schema
  if (rows.length > 0 && rows[0][2] === 'Amount (\u0e3f)') {
    rows[0] = NEW_HEADER;
    for (let i = 1; i < rows.length; i++) {
      const oldAmount = rows[i][2] || 0;
      rows[i] = [rows[i][0], rows[i][1], oldAmount, 0];
    }
  }
} else {
  wb = XLSX.utils.book_new();
  rows = [NEW_HEADER];
}

// Parse amount: strip currency symbols and commas, then convert to number
const numericAmount = parseFloat(String(amount).replace(/[^0-9.-]/g, ''));
if (isNaN(numericAmount) || numericAmount <= 0) {
  console.error(`Invalid amount: ${amount}`);
  process.exit(1);
}

if (type === 'income') {
  rows.push([date, name, numericAmount, 0]);
} else {
  rows.push([date, name, 0, numericAmount]);
}

// Rebuild the worksheet from rows
const newWs = XLSX.utils.aoa_to_sheet(rows);

// Apply Thai Baht number format to Income (col C) and Expense (col D) columns
const range = XLSX.utils.decode_range(newWs['!ref'] || 'A1');
for (let r = 1; r <= range.e.r; r++) {
  for (const c of [2, 3]) {
    const cellAddr = XLSX.utils.encode_cell({ r, c });
    if (newWs[cellAddr] && typeof newWs[cellAddr].v === 'number') {
      newWs[cellAddr].z = '#,##0.00';
    }
  }
}

// Set column widths for readability
newWs['!cols'] = [{ wch: 14 }, { wch: 36 }, { wch: 16 }, { wch: 16 }];

if (wb.SheetNames.length === 0) {
  XLSX.utils.book_append_sheet(wb, newWs, 'Sales');
} else {
  wb.Sheets[wb.SheetNames[0]] = newWs;
}

XLSX.writeFile(wb, xlsxPath);

const entryCount = rows.length - 1; // exclude header
const typeLabel = type === 'income' ? '\u0e23\u0e32\u0e22\u0e23\u0e31\u0e1a' : '\u0e23\u0e32\u0e22\u0e08\u0e48\u0e32\u0e22';
console.log(`Recorded (${typeLabel}): ${date} | ${name} | \u0e3f${numericAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
console.log(`File: ${xlsxPath} (${entryCount} total entries)`);
