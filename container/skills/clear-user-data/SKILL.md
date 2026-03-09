---
name: clear-user-data
description: Permanently delete all of the user's receipt images and message history. Call ONLY when the user explicitly asks to erase their data with phrases like "ลบข้อมูลของฉัน" or "Forget my data". The request itself is the confirmation — do not ask again.
allowed-tools: Bash(clear-user-data:*)
---

# Clear User Data

Deletes all receipt images from the workspace, deletes `daily_sales.xlsx`, and
sends a message history purge request to the host process via IPC. No arguments needed.

## Command

```bash
clear-user-data
```

## When to use

**Only** after the two-step confirmation gate in CLAUDE.md has completed:
1. Don sent a deletion trigger phrase
2. Sancho showed the record/image counts and asked for confirmation
3. Don replied with exactly `ยืนยันการลบ`

Never call this tool directly on the trigger phrase alone.

## After calling

Reply with exactly this message, nothing else:

> ดำเนินการลบข้อมูลเรียบร้อยแล้วครับ! 🗑️
>
> ผมได้ทำการลบประวัติการแชท รายการบัญชี และรูปภาพสลิปทั้งหมดของคุณออกจากหน่วยความจำในเครื่อง Mac เครื่องนี้แล้ว.
>
> ตอนนี้ผมไม่มีข้อมูลใดๆ ของคุณหลงเหลืออยู่ หากต้องการให้ผมช่วยบันทึกบัญชีใหม่ สามารถส่งรูปภาพหรือข้อความมาหาผมได้ทุกเมื่อครับ.
>
> Sancho พร้อมเริ่มต้นใหม่กับคุณเสมอครับ! 🙏
