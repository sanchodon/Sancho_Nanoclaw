#!/usr/bin/env node
// export-report — generate a formatted Excel report from daily_sales.xlsx
// Usage: export-report [--month YYYY-MM] [--output /path/to/report.xlsx]
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
const monthFilter = args.month || null;
const outputPath = args.output || path.join('/workspace/group', 'report.xlsx');
const inputPath = path.join('/workspace/group', 'daily_sales.xlsx');

if (!fs.existsSync(inputPath)) {
  console.error('NO_DATA: daily_sales.xlsx not found');
  process.exit(1);
}

const wb = XLSX.readFile(inputPath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws);

// Filter by month if requested
const filtered = monthFilter
  ? rows.filter(r => {
      const date = String(r['Date'] || r['date'] || '');
      return date.startsWith(monthFilter);
    })
  : rows;

if (filtered.length === 0) {
  console.log('NO_DATA');
  process.exit(0);
}

// Build category summary
const categoryTotals = {};
for (const r of filtered) {
  const cat = String(r['Category'] || r['หมวดหมู่'] || 'Other').trim();
  const amount = parseFloat(String(r['Amount'] || r['จำนวน'] || r['Expense (฿)'] || r['expense'] || 0).replace(/[^0-9.-]/g, '')) || 0;
  if (amount > 0) {
    categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
  }
}

const totalExpense = Object.values(categoryTotals).reduce((a, b) => a + b, 0);

// Sheet 1: Raw data (filtered)
const rawWs = XLSX.utils.json_to_sheet(filtered);
rawWs['!cols'] = [{ wch: 14 }, { wch: 36 }, { wch: 16 }, { wch: 20 }, { wch: 30 }];

// Sheet 2: Category summary
const summaryData = Object.entries(categoryTotals)
  .sort((a, b) => b[1] - a[1])
  .map(([cat, amt]) => ({
    'หมวดหมู่': cat,
    'จำนวน (฿)': amt,
    'สัดส่วน (%)': totalExpense > 0 ? ((amt / totalExpense) * 100).toFixed(1) + '%' : '0%',
  }));
summaryData.push({ 'หมวดหมู่': 'รวมทั้งหมด', 'จำนวน (฿)': totalExpense, 'สัดส่วน (%)': '100%' });

const summaryWs = XLSX.utils.json_to_sheet(summaryData);
summaryWs['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 14 }];

// Apply number format to amount column in summary
const sumRange = XLSX.utils.decode_range(summaryWs['!ref'] || 'A1');
for (let r = 1; r <= sumRange.e.r; r++) {
  const cellAddr = XLSX.utils.encode_cell({ r, c: 1 });
  if (summaryWs[cellAddr] && typeof summaryWs[cellAddr].v === 'number') {
    summaryWs[cellAddr].z = '#,##0.00';
  }
}

const newWb = XLSX.utils.book_new();
const period = monthFilter || 'All';
XLSX.utils.book_append_sheet(newWb, rawWs, 'รายการ');
XLSX.utils.book_append_sheet(newWb, summaryWs, `สรุป ${period}`);
XLSX.writeFile(newWb, outputPath);

console.log(`OK: ${outputPath}`);
console.log(`Rows: ${filtered.length}, Total: ฿${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`);
