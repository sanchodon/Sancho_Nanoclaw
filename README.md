# 🤖 NanoClaw — น้องอนันต์ ผู้ช่วยบัญชี AI สำหรับ SME ไทย

> ติดตั้งง่าย · ใช้ผ่าน LINE · ประหยัดสุดๆ · ไม่ต้องรู้โค้ด

---

## 🇹🇭 ภาษาไทย

### น้องอนันต์คืออะไร?

น้องอนันต์ (Anan) คือผู้ช่วยบัญชี AI ที่อยู่ใน LINE ของคุณ ส่งสลิปมา อนันต์จัดการให้หมด — จัดหมวดหมู่รายจ่าย บันทึกข้อมูล สรุปรายงานรายเดือน

**ราคาต่อสลิป: ~40 สตางค์** (ถูกกว่าโปรแกรมบัญชีทั่วไป 30 เท่า)

### ทำอะไรได้บ้าง?

- 📸 รับสลิปโอนเงินผ่าน LINE — จัดหมวดหมู่อัตโนมัติ
- 📊 สรุปรายจ่ายรายเดือน พร้อมเปรียบเทียบเดือนก่อน
- 🔐 ป้องกันการบันทึกซ้ำด้วย MD5 Hash
- 🎯 10 หมวดหมู่มาตรฐาน SME ไทย
- 💬 ตอบทั้งภาษาไทยและอังกฤษ
- ⚡ ตอบสั้น กระชับ ไม่เสียเวลา

### 10 หมวดหมู่มาตรฐาน

| # | หมวดหมู่ | ตัวอย่าง |
|---|----------|---------|
| 1 | #อาหาร | กิน, ข้าว, ร้านอาหาร |
| 2 | #เครื่องดื่ม | กาแฟ, น้ำ, ชา |
| 3 | #การเดินทาง | น้ำมัน, แท็กซี่, ที่จอดรถ |
| 4 | #ค่าเช่า | เช่าห้อง, บ้าน |
| 5 | #ค่าแรง | เงินเดือน, จ้างงาน |
| 6 | #ค่าน้ำไฟ | ไฟฟ้า, น้ำ, เน็ต |
| 7 | #อุปกรณ์ | วัสดุ, ของใช้ |
| 8 | #การตลาด | โฆษณา, Facebook, Google |
| 9 | #ภาษี | VAT, ประกันสังคม |
| 10 | #ส่วนตัว | ใช้เอง, ของขวัญ |

### ติดตั้ง (สำหรับ Mac เท่านั้น)

**ต้องมีก่อน:**
- Mac (macOS 26 Tahoe ขึ้นไป แนะนำ)
- [LINE Official Account](https://account.line.biz) (ฟรี)
- [Anthropic API Key](https://console.anthropic.com) (จ่ายตามใช้จริง)
- [ngrok](https://ngrok.com) account (ฟรี)

**คำสั่งติดตั้ง (copy แล้ว paste ใน Terminal):**

```bash
curl -fsSL https://gist.githubusercontent.com/sanchodon/2558bc7a9cae647e3619d40c51c52b54/raw/install-nanoclaw.sh | bash
```

สิ่งที่จะถูกติดตั้งอัตโนมัติ:
- Homebrew, Node.js, Git
- Apple Container
- NanoClaw (Anan · Maria · Nadia)
- Claude Code CLI

### หลังติดตั้ง

1. ใส่ค่าใน `.env`
   ```
   LINE_CHANNEL_ACCESS_TOKEN=your_token
   LINE_CHANNEL_SECRET=your_secret
   ANTHROPIC_API_KEY=your_key
   ```
2. เริ่ม Anan: `cd ~/nanoclaw && npm start`
3. เปิด tunnel: `ngrok http 3000`
4. ตั้ง Webhook URL ใน LINE Developer Console

---

## 🇬🇧 English

### What is NanoClaw?

NanoClaw is a self-hosted AI accounting assistant that lives in your LINE group. Send a payment slip, and Anan categorizes it, records it, and generates monthly reports — all automatically.

**Cost per transaction: ~฿0.002 (0.2 satang)** — 50x cheaper than typical accounting software subscriptions.

### Features

- 📸 Process payment slips via LINE automatically
- 📊 Monthly expense summaries with month-over-month comparison
- 🔐 Duplicate prevention via MD5 hashing
- 🎯 10 standard Thai SME categories
- 💬 Responds in Thai and English
- ⚡ Ultra-short responses to minimize token cost

### Requirements

- Mac (macOS 26 Tahoe or later recommended)
- [LINE Official Account](https://account.line.biz) (free tier available)
- [Anthropic API Key](https://console.anthropic.com) (pay per use)
- [ngrok](https://ngrok.com) account (free tier available)

### Install

```bash
curl -fsSL https://gist.githubusercontent.com/sanchodon/2558bc7a9cae647e3619d40c51c52b54/raw/install-nanoclaw.sh | bash
```

### Architecture

```
LINE Messaging API
      ↓
   ngrok tunnel
      ↓
 Andy / Anan (Node.js on Mac)
      ↓
 Anthropic API (Claude Haiku)
      ↓ (agent tasks, on demand)
 Apple Container (ephemeral)
```

### Cost Breakdown

| Component | Cost |
|-----------|------|
| LINE Official Account | Free (500 msg/month) |
| ngrok | Free (static domain) |
| Claude Haiku per slip | ~฿0.002 |
| Apple Container | Free (macOS built-in) |

---

## 🙏 Credits

- Original NanoClaw engine by [Gavriel](https://github.com/gavrielc/nanoclaw) — MIT License
- LINE integration, Anan accounting persona, and cost optimization by [Don Sancho](https://github.com/sanchodon)

---

## 📄 License

MIT License — free to use, modify, and distribute.
See [LICENSE](LICENSE) for details.
