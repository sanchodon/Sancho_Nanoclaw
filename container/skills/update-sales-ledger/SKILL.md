---
name: update-sales-ledger
description: Append a confirmed sale to daily_sales.xlsx. Only call this after the user has explicitly confirmed the details. Creates the file if it does not exist.
allowed-tools: Bash(update-sales-ledger:*)
---

# Update Sales Ledger

Appends one row to `daily_sales.xlsx` in the group workspace.

## Command

```bash
update-sales-ledger --date "YYYY-MM-DD" --name "Vendor or customer name" --amount "0.00"
```

## Rules

- **Never call this tool without explicit user confirmation.**
- Always show the detected values and ask before recording.
- After recording, confirm to the user what was saved and the total entry count.

## Example

```bash
update-sales-ledger --date "2024-01-15" --name "Sancho Supplies Co." --amount "3500.00"
# Recorded: 2024-01-15 | Sancho Supplies Co. | ฿3,500.00
# File: /workspace/group/daily_sales.xlsx (12 total entries)
```

## View the ledger

```bash
node -e "
const XLSX = require('xlsx');
const wb = XLSX.readFile('/workspace/group/daily_sales.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
console.log(JSON.stringify(XLSX.utils.sheet_to_json(ws), null, 2));
"
```
