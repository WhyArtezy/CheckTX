require("dotenv").config();
const { ethers } = require("ethers");
const axios = require("axios");
const fs = require("fs");

// ================= CONFIG =================

const WALLET_ADDRESS = process.env.WALLET_ADDRESS.toLowerCase();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const RPC_LIST = [
  process.env.RPC_1,
  process.env.RPC_2,
  process.env.RPC_3
].filter(Boolean);

const USDT_CONTRACT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// ================= GLOBAL =================

let provider;
let contract;
let sortedRpcList = [];
let currentRpcIndex = 0;
let lastBlock = 0;
let lastUpdateId = 0;

const USER_FILE = "user.json";
const BLOCK_FILE = "lastblock.txt";
let users = {};

// ================= USER STORAGE =================

function loadUsers() {
  if (fs.existsSync(USER_FILE)) {
    users = JSON.parse(fs.readFileSync(USER_FILE));
  }
}

function saveUsers() {
  fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
}

// ================= BLOCK STORAGE =================

function loadLastBlock() {
  if (fs.existsSync(BLOCK_FILE)) {
    lastBlock = parseInt(fs.readFileSync(BLOCK_FILE));
    console.log("Loaded lastBlock:", lastBlock);
  }
}

function saveLastBlock(block) {
  fs.writeFileSync(BLOCK_FILE, block.toString());
}

// ================= RPC SPEED TEST =================

async function testRpcSpeed(rpc) {
  const start = Date.now();
  try {
    const temp = new ethers.JsonRpcProvider(rpc);
    await temp.getBlockNumber();
    return { rpc, speed: Date.now() - start };
  } catch {
    return { rpc, speed: 999999 };
  }
}

async function rankRpcs() {
  console.log("⚡ Testing RPC speed...");
  const results = [];

  for (const rpc of RPC_LIST) {
    const result = await testRpcSpeed(rpc);
    console.log(`${rpc} → ${result.speed} ms`);
    results.push(result);
  }

  results.sort((a, b) => a.speed - b.speed);
  sortedRpcList = results.map(r => r.rpc);

  console.log("🏆 Fastest RPC:", sortedRpcList[0]);
}

// ================= RPC INIT =================

function initProvider() {
  const rpc = sortedRpcList[currentRpcIndex];
  console.log("🔄 Using RPC:", rpc);

  provider = new ethers.JsonRpcProvider(rpc, {
    name: "celo",
    chainId: 42220
  });

  contract = new ethers.Contract(USDT_CONTRACT, ABI, provider);
}

function switchRpc() {
  currentRpcIndex++;
  if (currentRpcIndex >= sortedRpcList.length) {
    currentRpcIndex = 0;
  }
  console.log("⚠ Switching RPC...");
  initProvider();
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.log("⚠ RPC error detected");
    switchRpc();
    return null;
  }
}

// ================= TELEGRAM =================

async function removeWebhook() {
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
  } catch {}
}

async function checkTelegram() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      { params: { offset: lastUpdateId + 1 } }
    );

    for (const update of res.data.result) {
      lastUpdateId = update.update_id;

      if (update.message && update.message.text === "/start") {
        const chatId = String(update.message.chat.id);

        if (!users[chatId]) {
          users[chatId] = { messageId: null };
          saveUsers();
          console.log("User baru:", chatId);
        }
      }
    }

  } catch {}
}

async function sendOrEdit(chatId, text) {
  try {

    if (!users[chatId].messageId) {

      const res = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }
      );

      users[chatId].messageId = res.data.result.message_id;
      saveUsers();

    } else {

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        {
          chat_id: chatId,
          message_id: users[chatId].messageId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }
      );

    }

  } catch (err) {

    if (err.response) {
      const code = err.response.data.error_code;

      if (code === 403) {
        delete users[chatId];
        saveUsers();
      }

      if (code === 400) return;
    }
  }
}

// ================= TRANSFER =================

async function checkTransfers() {

  const currentBlock = await safeCall(() => provider.getBlockNumber());
  if (!currentBlock) return;

  if (lastBlock === 0) {
    lastBlock = currentBlock - 1;
  }

  const events = await safeCall(() =>
    contract.queryFilter(contract.filters.Transfer(), lastBlock + 1, currentBlock)
  );

  if (events && events.length > 0) {

    for (const e of events) {

      const from = e.args.from.toLowerCase();
      const to = e.args.to.toLowerCase();

      if (from === WALLET_ADDRESS || to === WALLET_ADDRESS) {

        const decimals = await contract.decimals();
        const amount = ethers.formatUnits(e.args.value, decimals);
        const balanceRaw = await contract.balanceOf(WALLET_ADDRESS);
        const balance = ethers.formatUnits(balanceRaw, decimals);

        const block = await provider.getBlock(e.blockNumber);
        const time = new Date(block.timestamp * 1000).toLocaleString("id-ID");

        const isIn = to === WALLET_ADDRESS;
        const type = isIn ? "🟢 USDT IN" : "🔴 USDT OUT";
        const addressLine = isIn ? `From : ${from}` : `To : ${to}`;

        const addressUrl = `https://celoscan.io/address/${WALLET_ADDRESS}#tokentxns`;
        const txUrl = `https://celoscan.io/tx/${e.transactionHash}`;

        const message =
`Address : <a href="${addressUrl}">${WALLET_ADDRESS}</a>
Balance : ${balance} USDT

━━━━━━━━━━━━━━━━

${type}
${addressLine}
Jumlah : ${amount} USDT
Block : ${e.blockNumber}
Tx : <a href="${txUrl}">${e.transactionHash}</a>

${time}
`;

        for (const chatId of Object.keys(users)) {
          await sendOrEdit(chatId, message);
        }
      }
    }
  }

  lastBlock = currentBlock;
  saveLastBlock(currentBlock);
}

// ================= LOOP =================

async function transferLoop() {
  while (true) {
    await checkTransfers();
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ================= START =================

async function start() {

  await removeWebhook();
  loadUsers();
  loadLastBlock();

  await rankRpcs();
  initProvider();

  console.log("🚀 Bot Aktif");
  console.log("Total user:", Object.keys(users).length);

  setInterval(checkTelegram, 10000);
  transferLoop();
}

start();
