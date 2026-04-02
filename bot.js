require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const SYSTEM_PROMPT = `You are an expense extraction engine for an Indian group chat expense splitter app.

Your job: parse a chat message and extract EVERY expense mentioned into a JSON array.

You MUST return valid JSON in this exact format:
{
  "expenses": [
    {
      "payer": "name of person who paid (lowercase)",
      "amount": 1200,
      "description": "short 1-3 word description"
    }
  ]
}

CRITICAL RULES:

1. PAYER DETECTION:
   - "raj paid 1200 for hotel" → payer is "raj"
   - "I paid 500 petrol" → payer is the SENDER (given below)
   - "paid 300 uber" (no subject) → payer is the SENDER (given below)
   - "800 snacks" (no payer mentioned) → payer is the SENDER (given below)
   - "rahul ne 1k diya dinner" → payer is "rahul" (Hinglish: "ne ... diya" = paid)
   - "2.5k resort advance" (no payer) → payer is the SENDER (given below)
   - "Raj bhai ne hotel ka 1200 diya" → payer is "raj"

2. AMOUNT CONVERSION:
   - "1k" = 1000
   - "2.5k" = 2500
   - "1.5k" = 1500
   - "₹500" = 500
   - "500rs" or "500 rupees" or "500 inr" = 500
   - Always return amount as a number, never a string

3. DESCRIPTION:
   - Keep it short: 1-3 words max
   - "raj paid 1200 for hotel" → "hotel"
   - "800 snacks" → "snacks"
   - "2.5k resort advance" → "resort advance"

4. MULTI-LINE MESSAGES:
   - Each line is usually a separate expense
   - Extract ALL of them into the expenses array

5. NON-EXPENSE MESSAGES:
   - If a message has NO expense/money context at all, return: {"expenses": []}
   - Examples of non-expense: "hello", "when are we leaving?", "ok done"

Return ONLY the JSON object. No explanation, no markdown, no backticks.`;

async function parseExpense(messageText, senderName) {
  try {
    const userMessage = `SENDER NAME: ${senderName}\n\nMESSAGE:\n${messageText}`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const resultContent = response.data.choices[0].message.content;
    const cleanJson = resultContent.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    if (error.response) {
      console.error("Groq API Error:", error.response.data);
    } else {
      console.error("Parsing failed:", error.message);
    }
    return null;
  }
}

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return; // skip commands

  const senderName = msg.from.first_name || msg.from.username || "unknown";

  console.log(`\n--- MESSAGE from ${senderName} ---`);
  console.log(msg.text);

  const parsedData = await parseExpense(msg.text, senderName);

  if (parsedData && Array.isArray(parsedData.expenses) && parsedData.expenses.length > 0) {
    for (let i = 0; i < parsedData.expenses.length; i++) {
      const expense = parsedData.expenses[i];
      console.log(`\nPARSED [${i + 1}]:`);
      console.log(`  payer: "${expense.payer}"`);
      console.log(`  amount: ${expense.amount}`);
      console.log(`  description: "${expense.description}"`);

      const { error } = await supabase
        .from("expenses")
        .insert([
          {
            group_id: msg.chat.id,
            payer: expense.payer,
            amount: expense.amount,
            description: expense.description
          }
        ]);

      if (error) {
        console.error("Supabase Error:", error.message);
      } else {
        console.log("EXPENSE STORED");
      }
    }
  } else {
    console.log("(no expense detected)");
  }
});

bot.onText(/\/split/, async (msg) => {
  const groupId = msg.chat.id;

  const { data: expenses, error } = await supabase
    .from("expenses")
    .select("payer, amount")
    .eq("group_id", groupId);

  if (error) {
    console.error("Supabase Error:", error.message);
    bot.sendMessage(groupId, "❌ Error fetching expenses.");
    return;
  }

  if (!expenses || expenses.length === 0) {
    bot.sendMessage(groupId, "No expenses recorded yet for this group.");
    return;
  }

  // Compute totals per payer
  const paid = {};
  let total = 0;

  for (const row of expenses) {
    const name = row.payer.toLowerCase();
    paid[name] = (paid[name] || 0) + Number(row.amount);
    total += Number(row.amount);
  }

  const people = Object.keys(paid);
  const share = total / people.length;

  // Build balance lines
  let balanceLines = "";
  for (const person of people) {
    const balance = paid[person] - share;
    const sign = balance >= 0 ? "+" : "";
    const capitalized = person.charAt(0).toUpperCase() + person.slice(1);
    balanceLines += `${capitalized}: ${sign}₹${Math.round(balance)}\n`;
  }

  const message =
    `💰 *Split Summary*\n\n` +
    `Total: ₹${total}\n` +
    `Share per person: ₹${Math.round(share)}\n\n` +
    `*Balances:*\n${balanceLines}`;

  console.log("\n/split command triggered");
  console.log(message);

  bot.sendMessage(groupId, message, { parse_mode: "Markdown" });
});
