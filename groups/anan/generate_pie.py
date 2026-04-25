#!/usr/bin/env python3
import sys
import json
from collections import defaultdict

# Try to use matplotlib if available, otherwise create SVG
try:
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

def generate_pie_chart(data, month_filter=None):
    """Generate pie chart from expense data"""

    categories = defaultdict(float)

    for row in data:
        if isinstance(row, dict):
            date = row.get('Date', '')
            category = row.get('Category', 'Unknown')
            amount = float(row.get('Amount', 0))

            # Filter by month if specified
            if month_filter:
                if not date.startswith(month_filter):
                    continue

            categories[category] += amount

    if not categories:
        print("NO_DATA")
        return

    if HAS_MATPLOTLIB:
        # Create pie chart with matplotlib
        fig, ax = plt.subplots(figsize=(10, 8))

        labels = list(categories.keys())
        sizes = list(categories.values())
        colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8']

        # Ensure enough colors
        while len(colors) < len(labels):
            colors.append('#' + ''.join([hex(hash(l))[2:4] for l in labels[-1]]))

        wedges, texts, autotexts = ax.pie(
            sizes,
            labels=labels,
            autopct='%1.1f%%',
            colors=colors[:len(labels)],
            startangle=90
        )

        # Enhance text
        for text in texts:
            text.set_fontsize(12)
            text.set_weight('bold')

        for autotext in autotexts:
            autotext.set_color('white')
            autotext.set_fontsize(10)
            autotext.set_weight('bold')

        ax.set_title('Expense Breakdown by Category', fontsize=14, weight='bold', pad=20)

        plt.tight_layout()
        plt.savefig('/workspace/group/summary.png', dpi=150, bbox_inches='tight')
        print("OK")
    else:
        print("NO_DATA")

if __name__ == '__main__':
    try:
        data = json.loads(sys.argv[1])
        month = sys.argv[2] if len(sys.argv) > 2 else None
        generate_pie_chart(data, month)
    except Exception as e:
        print("NO_DATA")
