#!/usr/bin/env python3
"""
chart_gen.py — Spending Chart Generator for Anan AI Accountant
Reads daily_sales.xlsx (may be CSV) directly from /workspace/group/.
Usage: python3 /workspace/group/chart_gen.py [YYYY-MM]
"""

import sys
import os
import io
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

XLSX_PATH = '/workspace/group/daily_sales.xlsx'
OUTPUT_PATH = '/workspace/group/summary.png'

CHART_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#82E0AA',
    '#F0B27A', '#AED6F1',
]

CATEGORY_LABELS = {
    '#อาหาร': 'อาหาร (Food)',
    '#เครื่องดื่ม': 'เครื่องดื่ม (Drink)',
    '#การเดินทาง': 'เดินทาง (Travel)',
    '#ค่าเช่า': 'ค่าเช่า (Rent)',
    '#ค่าแรง': 'ค่าแรง (Wage)',
    '#ค่าน้ำไฟ': 'น้ำไฟ (Utility)',
    '#อุปกรณ์': 'อุปกรณ์ (Supply)',
    '#การตลาด': 'การตลาด (Marketing)',
    '#ภาษี': 'ภาษี (Tax)',
    '#ส่วนตัว': 'ส่วนตัว (Personal)',
}


def read_data():
    """Read xlsx or CSV file, return list of dicts."""
    if not os.path.exists(XLSX_PATH):
        return None

    # Try stdlib csv first (works when file is CSV regardless of extension)
    try:
        import csv
        with open(XLSX_PATH, newline='', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            if rows and reader.fieldnames:
                return rows
    except Exception:
        pass

    # Try as real xlsx with pandas/openpyxl
    try:
        import pandas as pd
        df = pd.read_excel(XLSX_PATH, engine='openpyxl')
        return df.to_dict(orient='records')
    except Exception as e:
        print(f'ERROR: cannot read file — {e}', file=sys.stderr)
        sys.exit(1)


def main():
    month_filter = sys.argv[1] if len(sys.argv) > 1 else None

    rows = read_data()
    if rows is None:
        print('NO_DATA')
        sys.exit(0)

    totals = {}

    for r in rows:
        # Date filter
        if month_filter:
            date = str(r.get('Date', r.get('date', ''))).strip()
            if not date.startswith(month_filter):
                continue

        # Amount
        raw_amount = r.get('Amount', r.get('amount', r.get('Expense', r.get('expense', 0))))
        try:
            amount = float(str(raw_amount).replace(',', '').strip())
        except (ValueError, TypeError):
            amount = 0.0
        if amount <= 0:
            continue

        # Category — use Category column directly if present
        category = str(r.get('Category', r.get('category', ''))).strip()
        if not category or category in ('nan', 'None', ''):
            category = 'Other'

        label = CATEGORY_LABELS.get(category, category)
        totals[label] = totals.get(label, 0.0) + amount

    if not totals:
        print('NO_DATA')
        sys.exit(0)

    sorted_items = sorted(totals.items(), key=lambda x: x[1], reverse=True)
    labels = [c for c, _ in sorted_items]
    amounts = [a for _, a in sorted_items]
    total_exp = sum(amounts)

    fig, ax = plt.subplots(figsize=(10, 8))
    colors = (CHART_COLORS * 3)[:len(labels)]
    wedges, texts, autotexts = ax.pie(
        amounts,
        labels=None,
        autopct='%1.1f%%',
        startangle=90,
        colors=colors,
        pctdistance=0.75,
    )
    for at in autotexts:
        at.set_color('white')
        at.set_fontweight('bold')
        at.set_fontsize(10)

    legend_labels = [f'{lbl}  ฿{amt:,.0f}' for lbl, amt in sorted_items]
    ax.legend(wedges, legend_labels, loc='center left', bbox_to_anchor=(1.0, 0.5),
              fontsize=9, frameon=False)

    period = month_filter if month_filter else 'All Time'
    ax.set_title(
        f'Expenses by Category ({period})\nTotal: ฿{total_exp:,.0f}',
        fontsize=13, fontweight='bold', pad=16,
    )

    plt.tight_layout()
    plt.savefig(OUTPUT_PATH, dpi=150, bbox_inches='tight')
    plt.close()
    print('OK')


if __name__ == '__main__':
    main()
