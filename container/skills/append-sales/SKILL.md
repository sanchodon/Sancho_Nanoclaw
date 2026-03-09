---
name: append-sales
description: Record a sale to sales_summary.csv. Use whenever the user sends a receipt, order photo, or asks to log a sale. Extracts Date, Name (vendor/item), and Amount from the context and appends a row.
allowed-tools: Bash(append-sales:*)
---

# Sales Logger

Append a sale to `sales_summary.csv` in the group workspace.

## Command

```bash
append-sales --date "YYYY-MM-DD" --name "Vendor or item name" --amount "0.00"
```

## Workflow for receipt images

When the user sends an image (appears as `[image: /workspace/group/images/<id>.jpg]`):

1. Read the image to extract the receipt details
2. Identify: Date, Name (vendor / customer / item description), Amount
3. Call `append-sales` with the extracted values
4. Show the user what was recorded

```bash
append-sales --date "2024-01-15" --name "Sancho Supplies Co." --amount "3500.00"
# Recorded: 2024-01-15 | Sancho Supplies Co. | 3500.00
```

## View or verify the log

```bash
cat /workspace/group/sales_summary.csv
```

## Working with Excel files (xlsx)

The `xlsx` package is available globally. To read an Excel file sent by the user:

```bash
node -e "
const XLSX = require('xlsx');
const wb = XLSX.readFile('/workspace/group/images/<file>.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
console.log(JSON.stringify(XLSX.utils.sheet_to_json(ws), null, 2));
"
```
