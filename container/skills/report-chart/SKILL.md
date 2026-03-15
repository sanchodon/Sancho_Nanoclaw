---
name: report-chart
description: Generate and send an expense pie chart from daily_sales.xlsx data, grouped by category. Can filter by month (e.g., 2026-03).
allowed-tools: Bash(report-chart:*)
---

# Report Chart

Generates a pie chart showing expenses by category from `daily_sales.xlsx` and saves it as `summary.png` in the group workspace.

## Command

Generate chart for all time:
```bash
python3 /workspace/group/chart_gen.py "$(node -e "const XLSX=require('xlsx');const wb=XLSX.readFile('/workspace/group/daily_sales.xlsx');const ws=wb.Sheets[wb.SheetNames[0]];console.log(JSON.stringify(XLSX.utils.sheet_to_json(ws)));" 2>/dev/null)"
```

Generate chart for a specific month (e.g., 2026-03):
```bash
python3 /workspace/group/chart_gen.py "$(node -e "const XLSX=require('xlsx');const wb=XLSX.readFile('/workspace/group/daily_sales.xlsx');const ws=wb.Sheets[wb.SheetNames[0]];console.log(JSON.stringify(XLSX.utils.sheet_to_json(ws)));" 2>/dev/null)" "2026-03"
```

## Output

On success:
- Creates `/workspace/group/summary.png` with pie chart
- Returns: `OK`

On error (no data):
- Returns: `NO_DATA`

## Rules

- Always offer to send the chart after generating it
- The pie chart groups expenses by category (Food & Drinks, Room & Utilities, Transport, Shopping, etc.)
- Month filter format: YYYY-MM (e.g., "2026-03")
- Categories are auto-detected from expense names using keyword matching

## Example Usage

```bash
# Generate report for current month
python3 /workspace/group/chart_gen.py "$(node -e "const XLSX=require('xlsx');const wb=XLSX.readFile('/workspace/group/daily_sales.xlsx');const ws=wb.Sheets[wb.SheetNames[0]];console.log(JSON.stringify(XLSX.utils.sheet_to_json(ws)));" 2>/dev/null)" "2026-03"

# Response will be OK and summary.png will be created
# Then send the image to user via sendMessage()
```
