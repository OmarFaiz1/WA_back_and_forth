/**
 * Combined Order Portal and WhatsApp Automation System
 */

require("dotenv").config();
const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const axios = require("axios");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const http = require("http");
const { Server } = require("socket.io");
const FormData = require("form-data");
const {
  emitOrdersUpdate,
  decrementDeliveryTimes,
} = require("./orderPortalSystem/index.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust to your frontend URL in production
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

app.use(express.json());
app.use(express.static(__dirname));

// Configuration
const PORT = process.env.PORT || 10000;
const POLL_INTERVAL = process.env.POLL_INTERVAL || 60000;
const RESEND_CHECK_INTERVAL = process.env.RESEND_CHECK_INTERVAL || 3600000;
const RESEND_HOURS_THRESHOLD = 4;
const QR_EXPIRY_SECONDS = 30; // QR code expires after 30 seconds
const NOTE_EDIT_WINDOW_HOURS = 12; // 12-hour window for note edits
const NOTE_REMINDER_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours in milliseconds

const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "aezenai.myshopify.com";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";
const SHOPIFY_ACCESS_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN || "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";

const DB_CONFIG = {
  host: process.env.DB_HOST || "mysql-7818684-zarposhdb.k.aivencloud.com",
  port: process.env.DB_PORT || 26074,
  user: process.env.DB_USER || "avnadmin",
  password: process.env.DB_PASS || "AVNS_kwlUH7gyVuaXjHbKyWe",
  database: process.env.DB_NAME || "postex_orders_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const BASE_URL = "https://wa-back-and-forth.onrender.com";

// API Configuration
const CX_GENIE_API_URL = "https://gateway.cxgenie.ai/api/v1/messages";
const CX_GENIE_BOT_ID = "addb60ab-9f77-4f14-af7e-f398ec73ca57";
const CX_GENIE_WORKSPACE_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3b3Jrc3BhY2VfaWQiOiI3MzY4ZGEwNi05Y2M2LTRlN2MtODJmOC0yMDdkYTM4YjVlMTIiLCJpYXQiOjE3NDQwODkwMDN9.G3ospWG5KoNL7l4ZygvAwhM4lV3_hApc8iSQWptgjDM";
const PREDICTION_API_URL = "https://imagexclassifier-1.onrender.com/api/predict";

// Image Processing Queue
const imageProcessingQueue = [];
let isProcessingImages = false;

// Message Templates
const MESSAGE_TEXT_TEMPLATE = (order) => {
  const confirmUrl = `${BASE_URL}/confirm/${order.order_ref_number}`;
  const rejectUrl = `${BASE_URL}/reject/${order.order_ref_number}`;
  return `
Hi *${order.customer_name}*,

Your order *${order.order_ref_number}* for PKR *${order.amount}* has been received.

───────────
*✅ CONFIRM*  
${confirmUrl}

*❌ REJECT*  
${rejectUrl}
───────────
`;
};

const NOTE_REMINDER_MESSAGE = (order) => {
  const noteUrl = `${BASE_URL}/confirm/${order.order_ref_number}`;
  return `
Dear *${order.customer_name}*,

You can still add or edit custom details for your order *${order.order_ref_number}* (PKR *${order.amount}*).

Please use the link below to add/edit your custom notes:
${noteUrl}

*Note*: This option is available for the next ${NOTE_EDIT_WINDOW_HOURS} hours from your order confirmation.

Best regards,
[Your Company Name]
`;
};

const AGENT_FEEDBACK_MESSAGE = (order, customerNote, agentMessage) => {
  return `
Dear *${order.customer_name}*,

Regarding your order *${order.order_ref_number}* (PKR *${order.amount}*), we have reviewed your custom note:

*Your Note*: ${customerNote}

*Our Response*: ${agentMessage}

Please contact us if you have any questions or need further assistance.

Best regards,
[Your Company Name]
`;
};

const DELIVERY_UPDATE_MESSAGE = (order, newDeliveryTime, reason) => {
  return `
Dear *${order.customer_name}*,

We are updating the delivery timeline for your order *${order.order_ref_number}* (PKR *${order.amount}*). The new expected delivery time is *${newDeliveryTime} day(s)*.

*Reason for Delay*: ${reason}

We apologize for any inconvenience and appreciate your understanding. Please contact us if you have any questions.

Best regards,
[Your Company Name]
`;
};

const CANCELLATION_MESSAGE = (order, reason) => {
  return `
Dear *${order.customer_name}*,

We regret to inform you that your order *${order.order_ref_number}* (PKR *${order.amount}*) has been cancelled.

*Reason for Cancellation*: ${reason}

We apologize for personally inconvenience caused. Please contact us if you have any questions or need further assistance.

Best regards,
[Your Company Name]
`;
};

// Initialize MySQL connection pool
const pool = mysql.createPool(DB_CONFIG);

// WhatsApp client initialization
let waClient = null;
let isClientReady = false;
let qrCode = null;
let qrExpiryTimer = null;

// Utility Functions
async function retryRequest(fn, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${attempt} of ${retries}`);
      return await fn();
    } catch (error) {
      if (
        attempt === retries ||
        !error.response ||
        (error.response.status !== 502 && error.response.status < 500)
      ) {
        throw error;
      }
      console.log(
        `[${new Date().toISOString()}] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Format the CX Genie API response
function formatCxGenieResponse(response) {
  // Check if response or response.data is missing or invalid
  if (!response || !response.data || !response.data.data) {
    console.error("Invalid response structure:", response ? JSON.stringify(response.data, null, 2) : "No response");
    return ["Sorry, I couldn't find any details."];
  }

  // Ensure the data field is a string
  const rawResponse = typeof response.data.data === "string" ? response.data.data : String(response.data.data);

  const MAX_MESSAGE_LENGTH = 4096;
  let messages = [];
  // Remove HTML tags and normalize newlines
  let formattedResponse = rawResponse.replace(/<strong>|<\/strong>/g, "").replace(/\\n/g, "\n");
  
  while (formattedResponse.length > 0) {
    if (formattedResponse.length <= MAX_MESSAGE_LENGTH) {
      messages.push(formattedResponse);
      formattedResponse = "";
    } else {
      let splitIndex = formattedResponse.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitIndex === -1) {
        splitIndex = MAX_MESSAGE_LENGTH;
      }
      messages.push(formattedResponse.slice(0, splitIndex));
      formattedResponse = formattedResponse.slice(splitIndex).trim();
    }
  }
  return messages.length > 0 ? messages : ["No details available."];
}

// Send message to CX Genie API and get response
async function sendToCxGenieApi({ content, senderName = "Unknown", phoneNumber = "" }) {
  try {
    const payload = {
      bot_id: CX_GENIE_BOT_ID,
      media: [{ url: "string" }], // Match API docs payload
      content: content || "",
      chat_user: {
        name: senderName,
        email: "default@example.com", // Add default email to match API requirements
        phone_number: phoneNumber,
      },
      workspace_token: CX_GENIE_WORKSPACE_TOKEN,
      metadata: {},
    };
    console.log(`📤 Sending to CX Genie API:`, JSON.stringify(payload, null, 2));
    const response = await retryRequest(async () => {
      const res = await axios.post(CX_GENIE_API_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CX_GENIE_WORKSPACE_TOKEN}`,
        },
        timeout: 60000,
      });
      return res;
    });
    console.log(`✅ CX Genie API response: Status ${response.status}`, JSON.stringify(response.data, null, 2));
    const replyTexts = formatCxGenieResponse(response);
    return replyTexts;
  } catch (error) {
    console.error(
      `❌ Error sending to CX Genie API: ${error.message}`,
      error.response ? JSON.stringify(error.response.data, null, 2) : "No response data"
    );
    return ["Sorry, I couldn't retrieve the details. Please try again."];
  }
}

async function sendToPredictionApi(imageBuffer, mimeType) {
  try {
    console.log(`[${new Date().toISOString()}] Preparing FormData for Prediction API`);
    const form = new FormData();
    form.append("test_image", imageBuffer, {
      filename: "image.jpg",
      contentType: mimeType || "image/jpeg",
    });
    const predictResponse = await retryRequest(async () => {
      console.log(`[${new Date().toISOString()}] Sending image to Prediction API`);
      const res = await axios.post(PREDICTION_API_URL, form, {
        headers: form.getHeaders(),
        timeout: 120000,
      });
      return res;
    });
    console.log(`[${new Date().toISOString()}] Prediction API response:`, JSON.stringify(predictResponse.data, null, 2));
    return predictResponse.data;
  } catch (error) {
    console.error(`❌ Error sending to Prediction API: ${error.message}`);
    return null;
  }
}

async function processImageQueue() {
  if (isProcessingImages || imageProcessingQueue.length === 0) return;
  isProcessingImages = true;
  while (imageProcessingQueue.length > 0) {
    const { message, senderName, phoneNumber } = imageProcessingQueue.shift();
    try {
      const media = await message.downloadMedia();
      if (media) {
        console.log(`✅ Media downloaded for ${phoneNumber} (${senderName})`);
        const imageBuffer = Buffer.from(media.data, "base64");
        const predictData = await sendToPredictionApi(imageBuffer, media.mimetype);
        if (predictData && predictData.result) {
          const predictedName = predictData.result;
          console.log(`[${new Date().toISOString()}] Predicted name: ${predictedName}`);
          const query = `Tell me price,description,link about ${predictedName}`;
          const apiResponse = await sendToCxGenieApi({
            content: query,
            senderName,
            phoneNumber,
          });
          if (apiResponse) {
            const replyTexts = formatCxGenieResponse(apiResponse);
            for (const replyText of replyTexts) {
              const sentMessage = await waClient.sendMessage(message.from, replyText);
              console.log(`📤 Sent API response to ${phoneNumber} (${senderName})`);
            }
          } else {
            const sentMessage = await waClient.sendMessage(
              message.from,
              "Sorry, I couldn't retrieve the details. Please try again."
            );
            console.log(`📤 Sent fallback message to ${phoneNumber} (${senderName})`);
          }
        } else {
          const sentMessage = await waClient.sendMessage(
            message.from,
            "Sorry, I couldn't identify the item in the image. Please try again."
          );
          console.log(`📤 Sent fallback message to ${phoneNumber} (${senderName})`);
        }
      } else {
        const sentMessage = await waClient.sendMessage(
          message.from,
          "Sorry, I couldn't process the image. Please try again."
        );
        console.log(`📤 Sent fallback message to ${phoneNumber} (${senderName})`);
      }
    } catch (error) {
      console.error(`❌ Error processing image for ${phoneNumber}: ${error.message}`);
      const sentMessage = await waClient.sendMessage(
        message.from,
        "Sorry, an error occurred while processing your image. Please try again."
      );
      console.log(`📤 Sent fallback message to ${phoneNumber} (${senderName})`);
    }
  }
  isProcessingImages = false;
}

async function initializeWhatsAppClient() {
  console.log("🔄 Initializing WhatsApp client...");
  try {
    waClient = new Client({
      authStrategy: new LocalAuth({ clientId: "order-confirmation-sender" }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--disable-gpu",
          "--no-zygote",
          "--single-process",
        ],
        executablePath: process.env.CHROMIUM_PATH || undefined,
      },
    });

    waClient.on("qr", (qr) => {
      console.log("🔑 New QR code generated for authentication:");
      qrCode = qr;
      qrcode.generate(qr, { small: false, margin: 2 }, (code) => {
        console.log(code);
      });
      if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
      qrExpiryTimer = setTimeout(() => {
        console.log("⏰ QR code expired. Generating a new one...");
        qrCode = null;
        waClient.resetQR();
      }, QR_EXPIRY_SECONDS * 1000);
    });

    waClient.on("authenticated", () => {
      console.log("✅ WhatsApp authenticated successfully");
      qrCode = null;
      if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    });

    waClient.on("ready", () => {
      console.log("🚀 WhatsApp client is ready");
      isClientReady = true;
    });

    waClient.on("disconnected", (reason) => {
      console.log(`❌ WhatsApp client disconnected: ${reason}`);
      isClientReady = false;
      qrCode = null;
      initializeWhatsAppClient();
    });

    waClient.on("message", async (message) => {
  let senderName = "Unknown";
  try {
    const contact = await message.getContact();
    senderName = contact.pushname || contact.name || "Unknown";
  } catch (error) {
    console.error(`❌ Error fetching sender name: ${error.message}`);
  }
  const phoneNumber = message.from.split("@")[0];
  console.log("📥 New incoming message received:");
  console.log(`  ↳ From: ${phoneNumber} (${senderName})`);
  console.log(`  ↳ Timestamp: ${new Date().toISOString()}`);

  try {
    if (message.hasMedia) {
      console.log(`🖼️ Message contains media (likely an image)`);
      imageProcessingQueue.push({ message, senderName, phoneNumber });
      await processImageQueue();
    } else {
      console.log(`  ↳ Body: ${message.body}`);
      const replyTexts = await sendToCxGenieApi({
        content: message.body,
        senderName,
        phoneNumber,
      });
      for (const replyText of replyTexts) {
        try {
          await waClient.sendMessage(message.from, replyText);
          console.log(`📤 Sent message to ${phoneNumber} (${senderName}): ${replyText}`);
        } catch (sendError) {
          console.error(`❌ Error sending message to ${phoneNumber}: ${sendError.message}`);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Error processing message from ${phoneNumber}: ${error.message}`);
    try {
      await waClient.sendMessage(
        message.from,
        "Sorry, an error occurred. Please try again."
      );
      console.log(`📤 Sent fallback message to ${phoneNumber} (${senderName})`);
    } catch (sendError) {
      console.error(`❌ Error sending fallback message to ${phoneNumber}: ${sendError.message}`);
    }
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM testingTrialAcc WHERE phone = ? ORDER BY order_ref_number DESC LIMIT 1",
      [phoneNumber]
    );
    if (rows.length > 0) {
      console.log(`✅ Sender ${phoneNumber} (${senderName}) is associated with order: ${rows[0].order_ref_number}`);
    } else {
      console.log(`⚠️ Sender ${phoneNumber} (${senderName}) is not associated with any known order.`);
    }
  } catch (error) {
    console.error(`❌ Error checking sender in database: ${error.message}`);
  }
});

    await waClient.initialize();
    console.log("✅ WhatsApp client initialization completed");
  } catch (err) {
    console.error(`❌ Failed to initialize WhatsApp client: ${err.message}`);
    setTimeout(initializeWhatsAppClient, 5000);
  }
}

async function waitForClientReady(timeoutMs = 60000) {
  console.log("⏳ Waiting for WhatsApp client to be ready...");
  const startTime = Date.now();
  while (!isClientReady && Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!isClientReady) {
    console.error("❌ WhatsApp client not ready after timeout");
    throw new Error("WhatsApp client not ready");
  }
  console.log("✅ WhatsApp client is ready");
}

function convertPhone(phone) {
  console.log(`🔍 Converting phone number: ${phone}`);
  if (phone.startsWith("0")) {
    const converted = "92" + phone.slice(1);
    console.log(`✅ Converted phone to: ${converted}`);
    return converted;
  }
  console.log(`ℹ️ Phone number already in correct format: ${phone}`);
  return phone;
}

async function sendOrderConfirmationMessage(order, retries = 3) {
  console.log(`📩 Preparing to send confirmation message for order ${order.order_ref_number}`);
  let attempt = 1;
  while (attempt <= retries) {
    try {
      console.log(`🔍 Attempt ${attempt} for sending confirmation to order ${order.order_ref_number}`);
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      if (!phone.match(/^\d{10,12}$/)) {
        console.warn(`⚠️ Invalid phone number for order ${order.order_ref_number}: ${phone}`);
        return false;
      }
      const messageText = MESSAGE_TEXT_TEMPLATE(order);
      console.log(`📤 Sending confirmation to ${phone} for order ${order.order_ref_number}`);
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Confirmation message sent successfully to ${phone} for order ${order.order_ref_number}`);
        await updateOrderMessageSent(order.order_ref_number);
        listenForOrderReply({ id: { _serialized: waId } }, order);
        return true;
      }
      console.log(`❌ Failed to send confirmation message to ${phone}`);
      return false;
    } catch (error) {
      console.error(`❌ Error sending confirmation for order ${order.order_ref_number} (Attempt ${attempt}): ${error.message}`);
      if (attempt === retries) {
        console.error(`❌ Max retries reached for order ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    attempt++;
  }
  return false;
}

async function sendNoteReminderMessage(order, retries = 3) {
  console.log(`📬 Preparing to send note reminder for order ${order.order_ref_number}`);
  let attempt = 1;
  while (attempt <= retries) {
    try {
      console.log(`🔍 Attempt ${attempt} for sending note reminder to order ${order.order_ref_number}`);
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      if (!phone.match(/^\d{10,12}$/)) {
        console.warn(`⚠️ Invalid phone number for order ${order.order_ref_number}: ${phone}`);
        return false;
      }
      const messageText = NOTE_REMINDER_MESSAGE(order);
      console.log(`📤 Sending note reminder to ${phone} for order ${order.order_ref_number}`);
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Note reminder sent successfully to ${phone} for order ${order.order_ref_number}`);
        return true;
      }
      console.log(`❌ Failed to send note reminder to ${phone}`);
      return false;
    } catch (error) {
      console.error(`❌ Error sending note reminder for order ${order.order_ref_number} (Attempt ${attempt}): ${error.message}`);
      if (attempt === retries) {
        console.error(`❌ Max retries reached for order ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    attempt++;
  }
  return false;
}

async function sendAgentFeedbackMessage(order, customerNote, agentMessage, retries = 3) {
  console.log(`📩 Preparing to send agent feedback for order ${order.order_ref_number}`);
  let attempt = 1;
  while (attempt <= retries) {
    try {
      console.log(`🔍 Attempt ${attempt} for sending agent feedback to order ${order.order_ref_number}`);
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      if (!phone.match(/^\d{10,12}$/)) {
        console.warn(`⚠️ Invalid phone number for order ${order.order_ref_number}: ${phone}`);
        return false;
      }
      const messageText = AGENT_FEEDBACK_MESSAGE(order, customerNote, agentMessage);
      console.log(`📤 Sending agent feedback to ${phone} for order ${order.order_ref_number}`);
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Agent feedback sent successfully to ${phone} for order ${order.order_ref_number}`);
        return true;
      }
      console.log(`❌ Failed to send agent feedback to ${phone}`);
      return false;
    } catch (error) {
      console.error(`❌ Error sending agent feedback for order ${order.order_ref_number} (Attempt ${attempt}): ${error.message}`);
      if (attempt === retries) {
        console.error(`❌ Max retries reached for order ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    attempt++;
  }
  return false;
}

async function sendDeliveryUpdateMessage(order, newDeliveryTime, reason, retries = 3) {
  console.log(`🚚 Preparing to send delivery update for order ${order.order_ref_number}`);
  let attempt = 1;
  while (attempt <= retries) {
    try {
      console.log(`🔍 Attempt ${attempt} for delivery update to order ${order.order_ref_number}`);
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      if (!phone.match(/^\d{10,12}$/)) {
        console.warn(`⚠️ Invalid phone number for order ${order.order_ref_number}: ${phone}`);
        return false;
      }
      const messageText = DELIVERY_UPDATE_MESSAGE(order, newDeliveryTime, reason);
      console.log(`📤 Sending delivery update to ${phone} for order ${order.order_ref_number}`);
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Delivery update sent successfully to ${phone} for order ${order.order_ref_number}`);
        return true;
      }
      console.log(`❌ Failed to send delivery update to ${phone}`);
      return false;
    } catch (error) {
      console.error(`❌ Error sending delivery update for order ${order.order_ref_number} (Attempt ${attempt}): ${error.message}`);
      if (attempt === retries) {
        console.error(`❌ Max retries reached for order ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    attempt++;
  }
  return false;
}

async function sendCancellationMessage(order, reason, retries = 3) {
  console.log(`🚨 Preparing to send cancellation message for order ${order.order_ref_number}`);
  let attempt = 1;
  while (attempt <= retries) {
    try {
      console.log(`🔍 Attempt ${attempt} for cancellation message to order ${order.order_ref_number}`);
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      if (!phone.match(/^\d{10,12}$/)) {
        console.warn(`⚠️ Invalid phone number for order ${order.order_ref_number}: ${phone}`);
        return false;
      }
      const messageText = CANCELLATION_MESSAGE(order, reason);
      console.log(`📤 Sending cancellation message to ${phone} for order ${order.order_ref_number}`);
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Cancellation message sent successfully to ${phone} for order ${order.order_ref_number}`);
        return true;
      }
      console.log(`❌ Failed to send cancellation message to ${phone}`);
      return false;
    } catch (error) {
      console.error(`❌ Error sending cancellation message for order ${order.order_ref_number} (Attempt ${attempt}): ${error.message}`);
      if (attempt === retries) {
        console.error(`❌ Max retries reached for order ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    attempt++;
  }
  return false;
}

function listenForOrderReply(contact, order) {
  const replyListener = (message) => {
    if (message.from === contact.id._serialized) {
      const reply = message.body.toLowerCase();
      if (reply === "yes" || reply === "no") {
        console.log(`📥 Received reply for order ${order.order_ref_number}: "${reply}"`);
        updateOrderStatusViaAPI(order.order_ref_number, reply);
        updateOrderStatusInDB(order.order_ref_number, reply);
        waClient.off("message", replyListener);
      }
    }
  };
  waClient.on("message", replyListener);
  setTimeout(() => {
    waClient.off("message", replyListener);
    console.log(`⏹️ Stopped listening for reply for order ${order.order_ref_number}`);
  }, 60000);
}

async function updateOrderStatusInDB(orderRefNumber, newStatus) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE testingTrialAcc SET status = ? WHERE order_ref_number = ?",
      [newStatus, orderRefNumber]
    );
    console.log(`✅ Order ${orderRefNumber} status updated in DB to "${newStatus}"`);
    await emitOrdersUpdate(io, pool);
  } catch (error) {
    console.error(`❌ Error updating order ${orderRefNumber} status in DB: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function updateOrderMessageSent(orderRefNumber) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE testingTrialAcc SET messageSent = 'yes' WHERE order_ref_number = ?",
      [orderRefNumber]
    );
    console.log(`✅ Marked message sent for order ${orderRefNumber}`);
  } catch (error) {
    console.error(`❌ Error updating messageSent for order ${orderRefNumber}: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function incrementLastMessageCounter(orderRefNumber) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE testingTrialAcc SET lastMessageSent = lastMessageSent + 1 WHERE order_ref_number = ?",
      [orderRefNumber]
    );
    console.log(`✅ Incremented lastMessageSent for order ${orderRefNumber}`);
  } catch (error) {
    console.error(`❌ Error incrementing lastMessageSent for order ${orderRefNumber}: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function saveCustomNote(orderRefNumber, note) {
  let connection;
  try {
    connection = await pool.getConnection();
    const [existing] = await connection.query(
      "SELECT * FROM CustomNotes WHERE order_ref_number = ?",
      [orderRefNumber]
    );
    if (existing.length > 0) {
      await connection.query(
        "UPDATE CustomNotes SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE order_ref_number = ?",
        [note, orderRefNumber]
      );
      console.log(`✅ Updated custom note for order ${orderRefNumber}`);
    } else {
      await connection.query(
        "INSERT INTO CustomNotes (order_ref_number, note) VALUES (?, ?)",
        [orderRefNumber, note]
      );
      console.log(`✅ Inserted custom note for order ${orderRefNumber}`);
    }
  } catch (error) {
    console.error(`❌ Error saving custom note for order ${orderRefNumber}: ${error.message}`);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function getCustomNote(orderRefNumber) {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT note FROM CustomNotes WHERE order_ref_number = ?",
      [orderRefNumber]
    );
    console.log(`✅ Fetched custom note for order ${orderRefNumber}`);
    return rows.length > 0 ? rows[0].note : null;
  } catch (error) {
    console.error(`❌ Error fetching custom note for order ${orderRefNumber}: ${error.message}`);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function canEditNote(orderRefNumber) {
  let connection;
  try {
    connection = await pool.getConnection();
    const [noteRows] = await connection.query(
      "SELECT created_at FROM CustomNotes WHERE order_ref_number = ?",
      [orderRefNumber]
    );
    let createdAt;
    if (noteRows.length > 0) {
      createdAt = new Date(noteRows[0].created_at);
    } else {
      const [orderRows] = await connection.query(
        "SELECT created_at FROM testingTrialAcc WHERE order_ref_number = ?",
        [orderRefNumber]
      );
      if (orderRows.length === 0) {
        console.log(`⚠️ Order ${orderRefNumber} not found`);
        return false;
      }
      createdAt = new Date(orderRows[0].created_at);
    }
    const now = new Date();
    const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
    const canEdit = hoursDiff <= NOTE_EDIT_WINDOW_HOURS;
    console.log(`🔍 Order ${orderRefNumber} note edit status: ${canEdit ? 'allowed' : 'expired'} (Hours since creation: ${hoursDiff.toFixed(2)})`);
    return canEdit;
  } catch (error) {
    console.error(`❌ Error checking note edit permission for order ${orderRefNumber}: ${error.message}`);
    return false;
  } finally {
    if (connection) connection.release();
  }
}

async function updateOrderStatusViaAPI(orderRefNumber, status) {
  const apiBaseUrl = BASE_URL + "/api";
  const apiKey = process.env.API_KEY || "fastians";
  try {
    console.log(`📡 Updating status via API for order ${orderRefNumber} to "${status}"`);
    const response = await axios.post(
      `${apiBaseUrl}/order/${orderRefNumber}/update-status`,
      { status },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`✅ Order ${orderRefNumber} status updated via API: ${JSON.stringify(response.data)}`);
  } catch (error) {
    console.error(`❌ Error updating status for order ${orderRefNumber} via API: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
  }
}

async function fetchShopifyOrders() {
  try {
    console.log("🔄 Fetching orders from Shopify...");
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any`;
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });
    if (response.data && response.data.orders) {
      console.log(`✅ Fetched ${response.data.orders.length} orders from Shopify`);
      return response.data.orders;
    }
    console.log("ℹ️ No orders found in Shopify response");
    return [];
  } catch (error) {
    console.error(`❌ Error fetching Shopify orders: ${error.message}`);
    return [];
  }
}

async function processNewShopifyOrders() {
  let connection;
  try {
    console.log("🔄 Processing new Shopify orders...");
    const orders = await fetchShopifyOrders();
    if (!orders.length) {
      console.log("ℹ️ No new Shopify orders to process");
      return;
    }
    connection = await pool.getConnection();
    for (const order of orders) {
      const orderRefNumber = order.order_number;
      const [rows] = await connection.query(
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
        [orderRefNumber]
      );
      if (rows.length === 0) {
        let phone = order.shipping_address && order.shipping_address.phone
          ? order.shipping_address.phone.replace(/\D/g, '')
          : null;
        if (phone && phone.match(/^\d{10,12}$/)) {
          console.log(`✅ Valid phone number for order ${orderRefNumber}: ${phone}`);
        } else {
          console.warn(`⚠️ Invalid or missing phone number for order ${orderRefNumber}, using default. Raw phone: ${order.shipping_address?.phone}`);
          phone = '0000000000';
        }
        const insertData = {
          order_ref_number: orderRefNumber,
          order_ref: order.id,
          customer_name: order.customer
            ? order.customer.first_name + " " + order.customer.last_name
            : "Customer",
          city: order.shipping_address
            ? order.shipping_address.city
            : "Unknown",
          phone: phone,
          amount: order.total_price,
          status: "no",
          delivery_time: 4,
          messageSent: "no",
          lastMessageSent: 0,
        };
        await connection.query(
          `INSERT INTO testingTrialAcc 
           (order_ref_number, order_ref, customer_name, city, phone, amount, status, delivery_time, messageSent, lastMessageSent) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            insertData.order_ref_number,
            insertData.order_ref,
            insertData.customer_name,
            insertData.city,
            insertData.phone,
            insertData.amount,
            insertData.status,
            insertData.delivery_time,
            insertData.messageSent,
            insertData.lastMessageSent,
          ]
        );
        console.log(`✅ Inserted new order ${orderRefNumber} into DB`);
        if (insertData.phone && insertData.phone !== '0000000000') {
          sendOrderConfirmationMessage(insertData);
        } else {
          console.warn(`⚠️ Skipping confirmation message for order ${orderRefNumber}: Invalid phone number`);
        }
      } else {
        console.log(`ℹ️ Order ${orderRefNumber} already exists in DB`);
      }
    }
  } catch (error) {
    console.error(`❌ Error processing Shopify orders: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function scheduleNoteReminders() {
  console.log("🔄 Checking for orders to send note reminders...");
  let connection;
  try {
    connection = await pool.getConnection();
    const [orders] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE status = 'yes' AND messageSent = 'yes'"
    );
    for (const order of orders) {
      const canEdit = await canEditNote(order.order_ref_number);
      if (canEdit) {
        const createdAt = new Date(order.created_at);
        const now = new Date();
        const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
        const remindersSent = Math.floor(hoursSinceCreation / 3);
        const lastReminder = remindersSent * 3;
        if (hoursSinceCreation >= lastReminder && lastReminder < NOTE_EDIT_WINDOW_HOURS) {
          console.log(`📬 Sending note reminder for order ${order.order_ref_number}`);
          await sendNoteReminderMessage(order);
        }
      }
    }
    console.log("✅ Note reminder check completed");
  } catch (error) {
    console.error(`❌ Error checking note reminders: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function syncShopifyOrders(pool) {
  console.log("🔄 Starting Shopify-MySQL sync process...");
  let connection;
  try {
    connection = await pool.getConnection();
    console.log("📡 Fetching Shopify orders...");
    const shopifyOrders = await fetchShopifyOrders();
    if (!shopifyOrders.length) {
      console.log("⚠️ No orders fetched from Shopify. Skipping sync.");
      return;
    }
    const formattedOrders = shopifyOrders.map((order) => {
      let customerName = "Guest";
      let city = "Unknown";
      let phone = null;
      if (order.customer && order.customer.first_name) {
        customerName = `${order.customer.first_name} ${order.customer.last_name || ""}`.trim();
      } else if (order.shipping_address && order.shipping_address.first_name) {
        customerName = `${order.shipping_address.first_name} ${order.shipping_address.last_name || ""}`.trim();
      }
      if (order.shipping_address && order.shipping_address.city) {
        city = order.shipping_address.city;
      }
      if (order.shipping_address && order.shipping_address.phone) {
        phone = order.shipping_address.phone.replace(/\D/g, '');
        if (!phone.match(/^\d{10,12}$/)) {
          console.warn(`⚠️ Invalid phone number for order ${order.order_number}, using default. Raw phone: ${order.shipping_address.phone}`);
          phone = '0000000000';
        } else {
          console.log(`✅ Valid phone number for order ${order.order_number}: ${phone}`);
        }
      } else {
        console.warn(`⚠️ Missing phone number for order ${order.order_number}, using default.`);
        phone = '0000000000';
      }
      return {
        order_ref_number: parseInt(order.order_number),
        order_ref: order.id,
        customer_name: customerName,
        city,
        phone,
        amount: parseFloat(order.total_price),
      };
    });
    console.log(`✅ Fetched ${formattedOrders.length} orders from Shopify.`);
    console.log("📊 Fetching existing orders from MySQL...");
    const [existingOrders] = await connection.query(
      "SELECT order_ref_number, order_ref, customer_name, city, phone, amount FROM testingTrialAcc"
    );
    console.log(`✅ Fetched ${existingOrders.length} orders from MySQL.`);
    const shopifyOrderNumbers = new Set(formattedOrders.map((order) => order.order_ref_number));
    const mysqlOrderNumbers = new Set(existingOrders.map((order) => order.order_ref_number));
    const ordersToDelete = [...mysqlOrderNumbers].filter((orderNumber) => !shopifyOrderNumbers.has(orderNumber));
    if (ordersToDelete.length > 0) {
      console.log(`🗑️ Found ${ordersToDelete.length} orders to delete...`);
      for (const orderNumber of ordersToDelete) {
        console.log(`🗑️ Removing order #${orderNumber} from database...`);
        await connection.query("DELETE FROM testingTrialAcc WHERE order_ref_number = ?", [orderNumber]);
        console.log(`✅ Removed order #${orderNumber}.`);
      }
    } else {
      console.log("✅ No orders to delete.");
    }
    const existingOrderMap = new Map(existingOrders.map((order) => [order.order_ref_number, order]));
    for (const order of formattedOrders) {
      console.log(`🔍 Processing order #${order.order_ref_number}...`);
      const existingOrder = existingOrderMap.get(order.order_ref_number);
      if (existingOrder) {
        const changes = [];
        if (existingOrder.order_ref !== order.order_ref) {
          changes.push(`order_ref changed from '${existingOrder.order_ref}' to '${order.order_ref}'`);
        }
        if (existingOrder.customer_name !== order.customer_name) {
          changes.push(`customer_name changed from '${existingOrder.customer_name}' to '${order.customer_name}'`);
        }
        if (existingOrder.city !== order.city) {
          changes.push(`city changed from '${existingOrder.city}' to '${order.city}'`);
        }
        if (existingOrder.phone !== order.phone) {
          changes.push(`phone changed from '${existingOrder.phone}' to '${order.phone}'`);
        }
        if (existingOrder.amount !== order.amount) {
          changes.push(`amount changed from '${existingOrder.amount}' to '${order.amount}'`);
        }
        if (changes.length > 0) {
          console.log(`🛠️ Updating order #${order.order_ref_number}...`);
          changes.forEach((change) => console.log(`  ↳ ${change}`));
          await connection.query(
            `UPDATE testingTrialAcc 
             SET order_ref = ?, customer_name = ?, city = ?, phone = ?, amount = ?
             WHERE order_ref_number = ?`,
            [order.order_ref, order.customer_name, order.city, order.phone, order.amount, order.order_ref_number]
          );
          console.log(`✅ Updated order #${order.order_ref_number}.`);
        } else {
          console.log(`✅ Order #${order.order_ref_number} is up-to-date.`);
        }
      } else {
        console.log(`➕ Inserting new order #${order.order_ref_number}...`);
        console.log(
          `  ↳ New order details: order_ref='${order.order_ref}', customer_name='${order.customer_name}', city='${order.city}', phone='${order.phone}', amount='${order.amount}'`
        );
        await connection.query(
          `INSERT INTO testingTrialAcc 
           (order_ref_number, order_ref, customer_name, city, phone, amount, status, delivery_time, messageSent, lastMessageSent) 
           VALUES (?, ?, ?, ?, ?, ?, 'no', 4, 'no', 0)`,
          [order.order_ref_number, order.order_ref, order.customer_name, order.city, order.phone, order.amount]
        );
        console.log(`✅ Inserted new order #${order.order_ref_number}.`);
        if (order.phone && order.phone !== '0000000000') {
          sendOrderConfirmationMessage(order);
        } else {
          console.warn(`⚠️ Skipping confirmation message for order ${order.order_ref_number}: Invalid phone number`);
        }
      }
    }
    console.log("🎉 Shopify-MySQL sync completed successfully!");
  } catch (err) {
    console.error(`❌ Error during Shopify-MySQL sync: ${err.message}`);
  } finally {
    if (connection) connection.release();
  }
}

async function checkForResendMessages() {
  let connection;
  try {
    console.log("🔄 Checking for orders to resend messages...");
    connection = await pool.getConnection();
    const [orders] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE status = 'no'"
    );
    for (const order of orders) {
      if (order.messageSent === "yes" && order.lastMessageSent >= RESEND_HOURS_THRESHOLD) {
        console.log(`🔄 Resending confirmation message for order ${order.order_ref_number}`);
        const updated = await sendOrderConfirmationMessage(order);
        if (updated) {
          await incrementLastMessageCounter(order.order_ref_number);
        }
      }
    }
    console.log("✅ Resend check completed");
  } catch (error) {
    console.error(`❌ Error checking orders for resend: ${error.message}`);
  } finally {
    if (connection) connection.release();
  }
}

app.get("/api/orders", async (req, res) => {
  const filter = req.query.filter || "all";
  const deliveryTime = req.query.deliveryTime;
  let query = `
    SELECT order_ref_number, customer_name, amount, status, delivery_time 
    FROM testingTrialAcc
  `;
  let queryParams = [];
  if (filter === "pending") {
    query += " WHERE status = 'yes' AND delivery_time > 0";
  } else if (filter === "completed") {
    query += " WHERE status = 'yes' AND delivery_time = 0";
  } else if (filter === "rejected") {
    query += " WHERE status = 'no'";
  } else if (deliveryTime && !isNaN(deliveryTime)) {
    query += " WHERE delivery_time = ?";
    queryParams.push(parseInt(deliveryTime));
  }
  try {
    console.log(`🔍 Fetching orders with filter: ${filter}, deliveryTime: ${deliveryTime || "all"}`);
    const [results] = await pool.query(query, queryParams);
    console.log(`✅ Fetched ${results.length} orders from DB`);
    res.json({ orders: results });
  } catch (err) {
    console.error(`❌ Error fetching orders: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.get("/api/order/:order_ref_number", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const query = `
    SELECT order_ref_number, customer_name, phone, amount, status, delivery_time, city
    FROM testingTrialAcc 
    WHERE order_ref_number = ?
  `;
  try {
    console.log(`🔍 Fetching details for order ${order_ref_number}`);
    const [results] = await pool.query(query, [order_ref_number]);
    if (results.length === 0) {
      console.log(`ℹ️ Order ${order_ref_number} not found`);
      return res.status(404).json({ error: "Order not found" });
    }
    console.log(`✅ Fetched details for order ${order_ref_number}`);
    res.json({ order: results[0] });
  } catch (err) {
    console.error(`❌ Error fetching order details: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.post("/api/order/:order_ref_number/update-status", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newStatus = req.body.status;
  const cancellationReason = req.body.cancellationReason;
  console.log(`📋 Status update request for order ${order_ref_number}:`, req.body);
  if (!newStatus || !["yes", "no"].includes(newStatus)) {
    console.log(`❌ Invalid status for order ${order_ref_number}: ${newStatus}`);
    return res.status(400).json({ error: "Invalid status" });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    console.log(`🔍 Checking 12-hour window for order ${order_ref_number}`);
    const [orderRows] = await connection.query(
      "SELECT created_at FROM testingTrialAcc WHERE order_ref_number = ?",
      [order_ref_number]
    );
    if (orderRows.length === 0) {
      console.log(`⚠️ Order ${order_ref_number} not found`);
      return res.status(404).json({ error: "Order not found" });
    }
    const createdAt = new Date(orderRows[0].created_at);
    const now = new Date();
    const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
    if (hoursDiff > NOTE_EDIT_WINDOW_HOURS) {
      console.log(`⛔ Status update window expired for order ${order_ref_number}`);
      return res.status(403).json({ error: "Sorry, 12 hours have passed. You can no longer update the order status." });
    }
    const updateSQL = "UPDATE testingTrialAcc SET status = ? WHERE order_ref_number = ?";
    console.log(`🔄 Updating status for order ${order_ref_number} to "${newStatus}"`);
    await connection.query(updateSQL, [newStatus, order_ref_number]);
    console.log(`✅ Updated status for order ${order_ref_number} to "${newStatus}"`);
    if (newStatus === "no" && cancellationReason) {
      const [orderResults] = await connection.query(
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
        [order_ref_number]
      );
      if (orderResults.length > 0) {
        console.log(`🚨 Sending cancellation message for order ${order_ref_number}`);
        await sendCancellationMessage(orderResults[0], cancellationReason);
      } else {
        console.warn(`⚠️ Order ${order_ref_number} not found for cancellation message`);
      }
    }
    await emitOrdersUpdate(io, pool);
    res.json({ message: `Status updated to ${newStatus}` });
  } catch (err) {
    console.error(`❌ Error updating status for order ${order_ref_number}: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/order/:order_ref_number/update-delivery", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newDeliveryTime = parseInt(req.body.delivery_time);
  const delayReason = req.body.delayReason || "Delivery time updated";
  console.log(`📋 Delivery update request for order ${order_ref_number}:`, req.body);
  if (isNaN(newDeliveryTime) || newDeliveryTime < 0) {
    console.log(`❌ Invalid delivery time for order ${order_ref_number}: ${newDeliveryTime}`);
    return res.status(400).json({ error: "Invalid delivery time" });
  }
  const updateSQL = "UPDATE testingTrialAcc SET delivery_time = ? WHERE order_ref_number = ?";
  try {
    console.log(`🔄 Updating delivery time for order ${order_ref_number} to ${newDeliveryTime}`);
    await pool.query(updateSQL, [newDeliveryTime, order_ref_number]);
    console.log(`✅ Updated delivery time for order ${order_ref_number} to ${newDeliveryTime}`);
    console.log(`🔍 Fetching order ${order_ref_number} for delivery update message`);
    const [orderResults] = await pool.query(
      "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
      [order_ref_number]
    );
    if (orderResults.length > 0) {
      const order = orderResults[0];
      console.log(`✅ Found order ${order_ref_number}:`, {
        customer_name: order.customer_name,
        phone: order.phone,
        amount: order.amount,
      });
      if (order.phone && order.phone !== "0000000000" && order.phone.match(/^\d{10,12}$/)) {
        console.log(`🚚 Sending delivery update message for order ${order_ref_number} with reason: ${delayReason}`);
        const messageSent = await sendDeliveryUpdateMessage(order, newDeliveryTime, delayReason);
        if (!messageSent) {
          console.warn(`⚠️ Failed to send delivery update message for order ${order_ref_number}`);
        }
      } else {
        console.warn(`⚠️ Skipping delivery update message for order ${order_ref_number}: Invalid phone number ${order.phone}`);
      }
    } else {
      console.warn(`⚠️ Order ${order_ref_number} not found in database for delivery update message`);
    }
    await emitOrdersUpdate(io, pool);
    res.json({ message: `Delivery time updated to ${newDeliveryTime}` });
  } catch (err) {
    console.error(`❌ Error updating delivery time for order ${order_ref_number}: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.post("/api/order/:order_ref_number/note", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const note = req.body.note;
  console.log(`📝 Received note for order ${order_ref_number}: ${note}`);
  try {
    const canEdit = await canEditNote(order_ref_number);
    if (!canEdit) {
      console.log(`⛔ Note edit window expired for order ${order_ref_number}`);
      return res.status(403).json({ error: "Sorry, 12 hours have passed. You can no longer add or edit the custom note." });
    }
    await saveCustomNote(order_ref_number, note);
    res.json({ message: "Note saved successfully" });
  } catch (err) {
    console.error(`❌ Error saving note for order ${order_ref_number}: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.get("/api/order/:order_ref_number/note", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  try {
    const note = await getCustomNote(order_ref_number);
    res.json({ note: note || "" });
  } catch (err) {
    console.error(`❌ Error fetching note for order ${order_ref_number}: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.post("/api/order/:order_ref_number/agent-feedback", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const agentMessage = req.body.message;
  console.log(`📩 Agent feedback for order ${order_ref_number}: ${agentMessage}`);
  try {
    const canEdit = await canEditNote(order_ref_number);
    if (!canEdit) {
      console.log(`⛔ Note edit window expired for order ${order_ref_number}`);
      return res.status(403).json({ error: "Sorry, 12 hours have passed. You can no longer add or edit the custom note." });
    }
    const [orderResults] = await pool.query(
      "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
      [order_ref_number]
    );
    if (orderResults.length === 0) {
      console.log(`⚠️ Order ${order_ref_number} not found`);
      return res.status(404).json({ error: "Order not found" });
    }
    const order = orderResults[0];
    const customerNote = await getCustomNote(order_ref_number) || "No note provided";
    const sent = await sendAgentFeedbackMessage(order, customerNote, agentMessage);
    if (sent) {
      console.log(`✅ Agent feedback sent for order ${order_ref_number}`);
      await saveCustomNote(order_ref_number, `${customerNote}\nAgent: ${agentMessage}`);
      res.json({ message: "Feedback sent successfully" });
    } else {
      console.log(`❌ Failed to send agent feedback for order ${order_ref_number}`);
      res.status(500).json({ error: "Failed to send feedback" });
    }
  } catch (err) {
    console.error(`❌ Error processing agent feedback for order ${order_ref_number}: ${err.message}`);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.get("/", (req, res) => {
  console.log("📄 Serving order portal frontend");
  res.sendFile(path.join(__dirname, "orderPortalSystem", "index.html"));
});

app.get("/api/status", (req, res) => {
  console.log("🔍 Health check requested");
  res.json({ status: "ok" });
});

app.get("/confirm/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`🔗 Order ${orderRef} accessed via confirm link`);
  let connection;
  try {
    connection = await pool.getConnection();
    const [orderResults] = await connection.query(
      "SELECT status, created_at FROM testingTrialAcc WHERE order_ref_number = ?",
      [orderRef]
    );
    if (orderResults.length === 0) {
      console.log(`⚠️ Order ${orderRef} not found`);
      return res.status(404).send("Order not found");
    }
    const createdAt = new Date(orderResults[0].created_at);
    const now = new Date();
    const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
    if (hoursDiff > NOTE_EDIT_WINDOW_HOURS) {
      console.log(`⛔ Confirmation window expired for order ${orderRef}`);
      return res.status(403).send("Sorry, 12 hours have passed. You can no longer confirm this order.");
    }
    if (orderResults[0].status !== "yes") {
      await updateOrderStatusViaAPI(orderRef, "yes");
      await updateOrderStatusInDB(orderRef, "yes");
      console.log(`✅ Order ${orderRef} status set to 'yes' locally`);
    }
    return res.sendFile(path.join(__dirname, "confirm.html"));
  } catch (e) {
    console.error(`❌ Error in confirm link flow: ${e.message}`);
    res.status(500).send("Internal Server Error");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/reject/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`🔗 Order ${orderRef} rejected via link`);
  let connection;
  try {
    connection = await pool.getConnection();
    const [orderResults] = await connection.query(
      "SELECT status, created_at FROM testingTrialAcc WHERE order_ref_number = ?",
      [orderRef]
    );
    if (orderResults.length === 0) {
      console.log(`⚠️ Order ${orderRef} not found`);
      return res.status(404).send("Order not found");
    }
    const createdAt = new Date(orderResults[0].created_at);
    const now = new Date();
    const hoursDiff = (now - createdAt) / (1000 * 60 * 60);
    if (hoursDiff > NOTE_EDIT_WINDOW_HOURS) {
      console.log(`⛔ Rejection window expired for order ${orderRef}`);
      return res.status(403).send("Sorry, 12 hours have passed. You can no longer reject this order.");
    }
    if (orderResults[0].status !== "no") {
      await updateOrderStatusViaAPI(orderRef, "no");
      await updateOrderStatusInDB(orderRef, "no");
      console.log(`✅ Order ${orderRef} status set to 'no' locally`);
    }
    return res.sendFile(path.join(__dirname, "reject.html"));
  } catch (e) {
    console.error(`❌ Error in reject link flow: ${e.message}`);
    res.status(500).send("Internal Server Error");
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/sendMessage/:phone", async (req, res) => {
  const phone = req.params.phone.trim();
  console.log(`📋 Manual message request for phone: ${phone}`);
  if (!phone.startsWith("92")) {
    console.log(`❌ Invalid phone number format: ${phone}`);
    return res.status(400).json({ error: "Phone number must start with 92." });
  }
  let connection;
  try {
    console.log(`🔄 Sending manual message to ${phone}`);
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE phone LIKE ? ORDER BY order_ref_number DESC LIMIT 1",
      [phone + "%"]
    );
    if (rows.length === 0) {
      console.log(`ℹ️ No order found for phone ${phone}`);
      return res.status(404).json({ error: "No order found for this phone number." });
    }
    const order = rows[0];
    console.log(`✅ Found order for phone ${phone}: ${order.order_ref_number}`);
    const sent = await sendOrderConfirmationMessage(order);
    if (sent) {
      console.log(`✅ Manual message sent to ${phone}`);
      res.json({ message: "Confirmation message sent." });
    } else {
      console.log(`❌ Failed to send manual message to ${phone}`);
      res.status(500).json({ error: "Failed to send confirmation message." });
    }
  } catch (error) {
    console.error(`❌ Error in manual send endpoint: ${error.message}`);
    res.status(500).json({ error: `Internal server error: ${error.message}` });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/api/sendCustomMessage", async (req, res) => {
  const { phone, message } = req.body;
  console.log(`📥 Received custom message request: phone=${phone}, message=${message}`);
  if (!phone || !message) {
    console.log(`❌ Missing phone or message in request`);
    return res.status(400).json({ error: "Phone and message are required" });
  }
  let cleanedPhone = phone.trim();
  if (!cleanedPhone.match(/^(?:92)?\d{10}$/)) {
    console.log(`❌ Invalid phone number format: ${cleanedPhone}`);
    return res.status(400).json({ error: "Invalid phone number format" });
  }
  try {
    await waitForClientReady();
    cleanedPhone = convertPhone(cleanedPhone);
    const waId = `${cleanedPhone}@c.us`;
    console.log(`📤 Sending custom message to ${cleanedPhone}`);
    const sentMessage = await waClient.sendMessage(waId, message);
    if (sentMessage) {
      console.log(`✅ Custom message sent successfully to ${cleanedPhone}`);
      res.json({ message: "Custom message sent successfully" });
    } else {
      console.log(`❌ Failed to send custom message to ${cleanedPhone}`);
      res.status(500).json({ error: "Failed to send custom message" });
    }
  } catch (error) {
    console.error(`❌ Error sending custom message to ${cleanedPhone}: ${error.message}`);
    res.status(500).json({ error: `Failed to send message: ${error.message}` });
  }
});

process.on("uncaughtException", (err) => {
  console.error(`❌ Uncaught Exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`❌ Unhandled Rejection at: ${promise} reason: ${reason}`);
});

io.on("connection", (socket) => {
  console.log(`🔗 Socket connected: ${socket.id}`);
  socket.on("disconnect", (reason) => {
    console.log(`🔗 Socket disconnected: ${socket.id}, Reason: ${reason}`);
  });
  socket.on("error", (error) => {
    console.error(`❌ Socket error: ${error.message}`);
  });
});

app.get("/health", async (req, res) => {
  console.log("🔍 Health check requested");
  res.json({ status: "healthy" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

initializeWhatsAppClient()
  .then(() => {
    console.log("🔄 Starting periodic tasks...");
    processNewShopifyOrders();
    setInterval(processNewShopifyOrders, POLL_INTERVAL);
    setInterval(checkForResendMessages, RESEND_CHECK_INTERVAL);
    setInterval(scheduleNoteReminders, NOTE_REMINDER_INTERVAL);
    setInterval(() => syncShopifyOrders(pool), 10 * 60 * 1000);
    setInterval(() => decrementDeliveryTimes(pool, io), 30 * 1000);
  })
  .catch((err) => {
    console.error(`❌ Fatal: could not initialize WhatsApp client: ${err.message}`);
    process.exit(1);
  });

process.on("SIGINT", async () => {
  console.log("🔄 Gracefully shutting down...");
  if (waClient) {
    try {
      await waClient.destroy();
    } catch (err) {
      console.error(`❌ Error destroying client: ${err.message}`);
    }
  }
  process.exit(0);
});
