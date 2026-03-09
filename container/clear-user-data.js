#!/usr/bin/env node
// clear-user-data — delete receipt images and request message history purge via IPC
// Usage: clear-user-data
'use strict';

const fs = require('fs');
const path = require('path');

const IMAGES_DIR = '/workspace/group/images';
const LEDGER_PATH = '/workspace/group/daily_sales.xlsx';
const IPC_TASKS_DIR = '/workspace/ipc/tasks';

// 1. Delete all receipt images (.jpg / .png / etc.) from the group workspace
let deletedCount = 0;
if (fs.existsSync(IMAGES_DIR)) {
  for (const file of fs.readdirSync(IMAGES_DIR)) {
    try {
      fs.unlinkSync(path.join(IMAGES_DIR, file));
      deletedCount++;
    } catch (err) {
      console.error(`Warning: could not delete ${file}: ${err.message}`);
    }
  }
}
console.log(`Deleted ${deletedCount} receipt image(s).`);

// 2. Delete the Excel sales ledger
if (fs.existsSync(LEDGER_PATH)) {
  fs.unlinkSync(LEDGER_PATH);
  console.log('Deleted daily_sales.xlsx.');
} else {
  console.log('daily_sales.xlsx not found — nothing to delete.');
}

// 3. Write IPC task to request message history purge from the host process.
//    The host derives the chatJid from the registered group — no need to pass it here.
fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
const taskFile = path.join(IPC_TASKS_DIR, `clear_user_data_${Date.now()}.json`);
fs.writeFileSync(taskFile, JSON.stringify({ type: 'clear_user_data' }));
console.log('Message history purge requested.');
