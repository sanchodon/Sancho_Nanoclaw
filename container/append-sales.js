#!/usr/bin/env node
// append-sales — append a sales row to sales_summary.csv
// Usage: append-sales --date "2024-01-15" --name "Vendor Name" --amount "1500.00"
'use strict';

const fs = require('fs');
const path = require('path');

function escapeCSV(value) {
  const str = String(value).trim();
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

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
const { date, name, amount } = args;

if (!date || !name || !amount) {
  console.error('Usage: append-sales --date "YYYY-MM-DD" --name "Customer/Item" --amount "0.00"');
  process.exit(1);
}

const csvPath = path.join('/workspace/group', 'sales_summary.csv');
const needsHeader = !fs.existsSync(csvPath);

if (needsHeader) {
  fs.writeFileSync(csvPath, 'Date,Name,Amount\n');
}

const row = `${escapeCSV(date)},${escapeCSV(name)},${escapeCSV(amount)}\n`;
fs.appendFileSync(csvPath, row);

console.log(`Recorded: ${date} | ${name} | ${amount}`);
console.log(`File: ${csvPath}`);
