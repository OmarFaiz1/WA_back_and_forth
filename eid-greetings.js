/**
 * Combined Order Portal and WhatsApp Automation System
 */

require("dotenv").config();
const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const axios = require("axios");
const { Client, RemoteAuth, LocalAuth } = require("whatsapp-web.js");
const { M彼此: MysqlStore } = require("wwebjs-mysql");
const qrcode = require("qrcode-terminal");
const http = require("http");
const { Server } = require("socket.io");
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
  transports: ["websocket", "polling"], // Explicitly allow both transports
  allowEIO3: true, // Support for Socket.IO v3 clients
});

app.use(express.json());
app.use(express.static(__dirname));

// Configuration
const PORT = process.env.PORT || 10000;
const POLL_INTERVAL = process.env.POLL_INTERVAL || 60000;
const RESEND_CHECK_INTERVAL = process.env.RESEND_CHECK_INTERVAL || 3600000;
const RESEND_HOURS_THRESHOLD = 4;

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

const BASE_URL = "https://wa-order-portal.onrender.com";

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

We apologize for any inconvenience caused. Please contact us if you have any questions or need further assistance.

Best regards,
[Your Company Name]
`;
};

// Initialize MySQL connection pool
const pool = mysql.createPool(DB_CONFIG);

// Configure MysqlStore for RemoteAuth
const tableInfo = {
  table: "wsp_sessions",
  session_column: "session_name",
  data_column: "data",
  updated_at_column: "updated_at",
};
const store = new MysqlStore({ pool, tableInfo });

// WhatsApp client initialization
let waClient = null;
let isClientReady = false;
let authFailureCount = 0;
const MAX_AUTH_ATTEMPTS = 3;

async function initializeWhatsAppClient(useRemoteAuth = true) {
  if (waClient && isClientReady) return;
  return new Promise((resolve, reject) => {
    console.log(
      `🔄 Initializing WhatsApp client (RemoteAuth: ${useRemoteAuth})...`
    );

    // Choose authentication strategy
    const authStrategy = useRemoteAuth
      ? new RemoteAuth({
          store,
          clientId: "order-confirmation-sender",
          backupSyncIntervalMs: 300000, // Sync session every 5 minutes
        })
      : new LocalAuth({ clientId: "order-confirmation-sender" });

    waClient = new Client({
      authStrategy,
      puppeteer: {
        headless: process.env.HEADLESS_MODE !== "false",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--disable-gpu",
          "--disable-extensions",
          "--no-zygote", // Improve stability in low-memory environments
          "--single-process", // Reduce memory footprint
        ],
        executablePath: process.env.CHROMIUM_PATH || undefined, // Optional: Specify path if using custom Chromium
      },
    });

    waClient.on("qr", (qr) => {
      console.log(
        "🔑 QR code generated for authentication. Scan the QR code below:"
      );
      qrcode.generate(qr, { small: false, margin: 2 }, (code) => {
        console.log(code); // Print QR code to terminal
      });
    });

    waClient.on("authenticated", () => {
      console.log("✅ WhatsApp authenticated successfully.");
      authFailureCount = 0; // Reset failure counter
    });

    waClient.on("auth_failure", async (msg) => {
      console.error("❌ WhatsApp authentication failed:", msg);
      isClientReady = false;
      authFailureCount++;
      console.log(`🔄 Authentication failure count: ${authFailureCount}`);

      if (authFailureCount >= MAX_AUTH_ATTEMPTS && useRemoteAuth) {
        console.log(
          "⚠️ Max authentication attempts reached. Falling back to QR code authentication..."
        );
        // Clear session data from MySQL
        try {
          await pool.query("DELETE FROM wsp_sessions WHERE session_name = ?", [
            "order-confirmation-sender",
          ]);
          console.log("✅ Cleared session data from database.");
        } catch (err) {
          console.error("❌ Error clearing session data:", err.message);
        }
        // Reinitialize with LocalAuth (QR code)
        await initializeWhatsAppClient(false);
      }
      reject(new Error("WhatsApp auth failure"));
    });

    waClient.on("ready", () => {
      console.log("🚀 WhatsApp client is ready.");
      isClientReady = true;
      resolve();
    });

    waClient.on("disconnected", (reason) => {
      console.log(`❌ WhatsApp client disconnected: ${reason}`);
      isClientReady = false;
      // Attempt to reinitialize
      setTimeout(() => initializeWhatsAppClient(useRemoteAuth), 5000);
    });

    waClient.initialize().catch((err) => {
      console.error("❌ Failed to initialize WhatsApp client:", err.message);
      isClientReady = false;
      reject(err);
    });
  });
}

// Utility: Wait for client readiness with timeout
async function waitForClientReady(timeoutMs = 30000) {
  const startTime = Date.now();
  while (!isClientReady && Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!isClientReady) {
    throw new Error("WhatsApp client not ready");
  }
}

// Utility: Convert phone number
function convertPhone(phone) {
  if (phone.startsWith("0")) {
    return "92" + phone.slice(1);
  }
  return phone;
}

// Send order confirmation message
async function sendOrderConfirmationMessage(order, retries = 3) {
  let attempt = 1;
  while (attempt <= retries) {
    try {
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      const contact = {
        id: { user: phone, _serialized: waId },
        name: order.customer_name || "Customer",
      };
      const messageText = MESSAGE_TEXT_TEMPLATE(order);
      console.log(
        `📤 Sending confirmation message to ${contact.id.user} (Attempt ${attempt})...`
      );
      const sentMessage = await waClient.sendMessage(
        contact.id._serialized,
        messageText
      );
      if (sentMessage) {
        console.log(`✅ Message sent to ${contact.id.user}`);
        await updateOrderMessageSent(order.order_ref_number);
        listenForOrderReply(contact, order);
        return true;
      }
      console.log(`❌ Message sending failed for ${contact.id.user}`);
      return false;
    } catch (error) {
      console.error(
        `❌ Error sending confirmation message (Attempt ${attempt}):`,
        error.message
      );
      if (attempt === retries) {
        console.error(`❌ Max retries reached for ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      if (
        error.message.includes("WidFactory") ||
        error.message.includes("disconnected")
      ) {
        console.log("🔄 Reinitializing WhatsApp client due to error...");
        isClientReady = false;
        await initializeWhatsAppClient();
      }
    }
    attempt++;
  }
  return false;
}

// Send delivery update message with retry logic
async function sendDeliveryUpdateMessage(
  order,
  newDeliveryTime,
  reason,
  retries = 3
) {
  let attempt = 1;
  while (attempt <= retries) {
    try {
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      const messageText = DELIVERY_UPDATE_MESSAGE(
        order,
        newDeliveryTime,
        reason
      );
      console.log(
        `📤 Sending delivery update message to ${phone} (Attempt ${attempt})...`
      );
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Delivery update message sent to ${phone}`);
        return true;
      }
      console.log(`❌ Delivery update message failed for ${phone}`);
      return false;
    } catch (error) {
      console.error(
        `❌ Error sending delivery update message (Attempt ${attempt}):`,
        error.message
      );
      if (attempt === retries) {
        console.error(`❌ Max retries reached for ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      if (
        error.message.includes("WidFactory") ||
        error.message.includes("disconnected")
      ) {
        console.log("🔄 Reinitializing WhatsApp client due to error...");
        isClientReady = false;
        await initializeWhatsAppClient();
      }
    }
    attempt++;
  }
  return false;
}

// Send cancellation message
async function sendCancellationMessage(order, reason, retries = 3) {
  let attempt = 1;
  while (attempt <= retries) {
    try {
      await waitForClientReady();
      let phone = order.phone.trim();
      phone = convertPhone(phone);
      const waId = `${phone}@c.us`;
      const messageText = CANCELLATION_MESSAGE(order, reason);
      console.log(
        `📤 Sending cancellation message to ${phone} (Attempt ${attempt})...`
      );
      const sentMessage = await waClient.sendMessage(waId, messageText);
      if (sentMessage) {
        console.log(`✅ Cancellation message sent to ${phone}`);
        return true;
      }
      console.log(`❌ Cancellation message failed for ${phone}`);
      return false;
    } catch (error) {
      console.error(
        `❌ Error sending cancellation message (Attempt ${attempt}):`,
        error.message
      );
      if (attempt === retries) {
        console.error(`❌ Max retries reached for ${order.order_ref_number}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      if (
        error.message.includes("WidFactory") ||
        error.message.includes("disconnected")
      ) {
        console.log("🔄 Reinitializing WhatsApp client due to error...");
        isClientReady = false;
        await initializeWhatsAppClient();
      }
    }
    attempt++;
  }
  return false;
}

// Listen for order reply
function listenForOrderReply(contact, order) {
  const replyListener = (message) => {
    if (message.from === contact.id._serialized) {
      const reply = message.body.toLowerCase();
      if (reply === "yes" || reply === "no") {
        console.log(
          `📥 Received reply for order ${order.order_ref_number}: "${reply}"`
        );
        updateOrderStatusViaAPI(order.order_ref_number, reply);
        updateOrderStatusInDB(order.order_ref_number, reply);
        waClient.off("message", replyListener);
      }
    }
  };
  waClient.on("message", replyListener);
  setTimeout(() => {
    waClient.off("message", replyListener);
    console.log(
      `⏹️ Stopped listening for reply for order ${order.order_ref_number}`
    );
  }, 60000);
}

// Update order status in DB
async function updateOrderStatusInDB(orderRefNumber, newStatus) {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "UPDATE testingTrialAcc SET status = ? WHERE order_ref_number = ?",
      [newStatus, orderRefNumber]
    );
    console.log(
      `✅ Order ${orderRefNumber} status updated in DB to "${newStatus}"`
    );
  } catch (error) {
    console.error(
      `❌ Error updating order ${orderRefNumber} status in DB:`,
      error.message
    );
  } finally {
    if (connection) connection.release();
  }
}

// Mark message sent
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
    console.error(
      `❌ Error updating messageSent for order ${orderRefNumber}:`,
      error.message
    );
  } finally {
    if (connection) connection.release();
  }
}

// Increment last message counter
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
    console.error(
      `❌ Error incrementing lastMessageSent for order ${orderRefNumber}:`,
      error.message
    );
  } finally {
    if (connection) connection.release();
  }
}

// Update order status via API (self-referencing)
async function updateOrderStatusViaAPI(orderRefNumber, status) {
  const apiBaseUrl = BASE_URL + "/api";
  const apiKey = process.env.API_KEY || "fastians";
  try {
    console.log(
      `📡 Updating status via API for order ${orderRefNumber} to "${status}"`
    );
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
    console.log(
      `✅ Order ${orderRefNumber} status updated via API:`,
      response.data
    );
  } catch (error) {
    console.error(
      `❌ Error updating status for order ${orderRefNumber} via API:`,
      error.response ? error.response.data : error.message
    );
  }
}

// Fetch Shopify orders
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
      console.log(
        `✅ Fetched ${response.data.orders.length} orders from Shopify`
      );
      return response.data.orders;
    }
    console.log("ℹ️ No orders found in Shopify response");
    return [];
  } catch (error) {
    console.error("❌ Error fetching Shopify orders:", error.message);
    return [];
  }
}

// Process new Shopify orders
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
        const insertData = {
          order_ref_number: orderRefNumber,
          order_ref: order.id,
          customer_name: order.customer
            ? order.customer.first_name + " " + order.customer.last_name
            : "Customer",
          city: order.shipping_address
            ? order.shipping_address.city
            : "Unknown",
          phone:
            order.shipping_address && order.shipping_address.phone
              ? order.shipping_address.phone
              : "0000000000",
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
        sendOrderConfirmationMessage(insertData);
      } else {
        console.log(`ℹ️ Order ${orderRefNumber} already exists in DB`);
      }
    }
  } catch (error) {
    console.error("❌ Error processing Shopify orders:", error.message);
  } finally {
    if (connection) connection.release();
  }
}

// Full Shopify-MySQL sync with updates and deletions
async function syncShopifyOrders(pool) {
  console.log("🔄 Starting Shopify-MySQL sync process...");
  let connection;
  try {
    connection = await pool.getConnection();

    // Fetch Shopify orders
    console.log("📡 Fetching Shopify orders...");
    const shopifyOrders = await fetchShopifyOrders();
    if (!shopifyOrders.length) {
      console.log("⚠️ No orders fetched from Shopify. Skipping sync.");
      return;
    }

    // Map Shopify orders to match MySQL schema
    const formattedOrders = shopifyOrders.map((order) => {
      let customerName = "Guest";
      let city = "Unknown";
      let phone = "Unknown";

      if (order.customer && order.customer.first_name) {
        customerName = `${order.customer.first_name} ${
          order.customer.last_name || ""
        }`.trim();
      } else if (order.shipping_address && order.shipping_address.first_name) {
        customerName = `${order.shipping_address.first_name} ${
          order.shipping_address.last_name || ""
        }`.trim();
      }

      if (order.shipping_address && order.shipping_address.city) {
        city = order.shipping_address.city;
      }

      if (order.shipping_address && order.shipping_address.phone) {
        phone = order.shipping_address.phone;
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

    // Fetch existing orders from MySQL
    console.log("📊 Fetching existing orders from MySQL...");
    const [existingOrders] = await connection.query(
      "SELECT order_ref_number, order_ref, customer_name, city, phone, amount FROM testingTrialAcc"
    );
    console.log(`✅ Fetched ${existingOrders.length} orders from MySQL.`);

    // Create sets for comparison
    const shopifyOrderNumbers = new Set(
      formattedOrders.map((order) => order.order_ref_number)
    );
    const mysqlOrderNumbers = new Set(
      existingOrders.map((order) => order.order_ref_number)
    );

    // Identify orders to delete (in MySQL but not in Shopify)
    const ordersToDelete = [...mysqlOrderNumbers].filter(
      (orderNumber) => !shopifyOrderNumbers.has(orderNumber)
    );

    // Process deletions
    if (ordersToDelete.length > 0) {
      console.log(`🗑️ Found ${ordersToDelete.length} orders to delete...`);
      for (const orderNumber of ordersToDelete) {
        console.log(`🗑️ Removing order #${orderNumber} from database...`);
        await connection.query(
          "DELETE FROM testingTrialAcc WHERE order_ref_number = ?",
          [orderNumber]
        );
        console.log(`✅ Removed order #${orderNumber}.`);
      }
    } else {
      console.log("✅ No orders to delete.");
    }

    // Process each Shopify order (insertions and updates)
    const existingOrderMap = new Map(
      existingOrders.map((order) => [order.order_ref_number, order])
    );

    for (const order of formattedOrders) {
      console.log(`🔍 Processing order #${order.order_ref_number}...`);
      const existingOrder = existingOrderMap.get(order.order_ref_number);

      if (existingOrder) {
        // Check for differences
        const changes = [];
        if (existingOrder.order_ref !== order.order_ref) {
          changes.push(
            `order_ref changed from '${existingOrder.order_ref}' to '${order.order_ref}'`
          );
        }
        if (existingOrder.customer_name !== order.customer_name) {
          changes.push(
            `customer_name changed from '${existingOrder.customer_name}' to '${order.customer_name}'`
          );
        }
        if (existingOrder.city !== order.city) {
          changes.push(
            `city changed from '${existingOrder.city}' to '${order.city}'`
          );
        }
        if (existingOrder.phone !== order.phone) {
          changes.push(
            `phone changed from '${existingOrder.phone}' to '${order.phone}'`
          );
        }
        if (existingOrder.amount !== order.amount) {
          changes.push(
            `amount changed from '${existingOrder.amount}' to '${order.amount}'`
          );
        }

        if (changes.length > 0) {
          console.log(`🛠️ Updating order #${order.order_ref_number}...`);
          changes.forEach((change) => console.log(`  ↳ ${change}`));
          await connection.query(
            `UPDATE testingTrialAcc 
             SET order_ref = ?, customer_name = ?, city = ?, phone = ?, amount = ?
             WHERE order_ref_number = ?`,
            [
              order.order_ref,
              order.customer_name,
              order.city,
              order.phone,
              order.amount,
              order.order_ref_number,
            ]
          );
          console.log(`✅ Updated order #${order.order_ref_number}.`);
        } else {
          console.log(`✅ Order #${order.order_ref_number} is up-to-date.`);
        }
      } else {
        // Insert new order
        console.log(`➕ Inserting new order #${order.order_ref_number}...`);
        console.log(
          `  ↳ New order details: order_ref='${order.order_ref}', customer_name='${order.customer_name}', city='${order.city}', phone='${order.phone}', amount='${order.amount}'`
        );
        await connection.query(
          `INSERT INTO testingTrialAcc 
           (order_ref_number, order_ref, customer_name, city, phone, amount, status, delivery_time, messageSent, lastMessageSent) 
           VALUES (?, ?, ?, ?, ?, ?, 'no', 4, 'no', 0)`,
          [
            order.order_ref_number,
            order.order_ref,
            order.customer_name,
            order.city,
            order.phone,
            order.amount,
          ]
        );
        console.log(`✅ Inserted new order #${order.order_ref_number}.`);
        // Trigger WhatsApp confirmation for new orders
        sendOrderConfirmationMessage(order);
      }
    }

    console.log("🎉 Shopify-MySQL sync completed successfully!");
  } catch (err) {
    console.error("❌ Error during Shopify-MySQL sync:", err.message);
  } finally {
    if (connection) connection.release();
  }
}

// Check for resend messages
async function checkForResendMessages() {
  let connection;
  try {
    console.log("🔄 Checking for orders to resend messages...");
    connection = await pool.getConnection();
    const [orders] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE status = 'no'"
    );
    for (const order of orders) {
      if (
        order.messageSent === "yes" &&
        order.lastMessageSent >= RESEND_HOURS_THRESHOLD
      ) {
        console.log(
          `🔄 Resending confirmation message for order ${order.order_ref_number}`
        );
        const updated = await sendOrderConfirmationMessage(order);
        if (updated) {
          await incrementLastMessageCounter(order.order_ref_number);
        }
      }
    }
    console.log("✅ Resend check completed");
  } catch (error) {
    console.error("❌ Error checking orders for resend:", error.message);
  } finally {
    if (connection) connection.release();
  }
}

// Order Portal Routes
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
    console.log(
      `🔍 Fetching orders with filter: ${filter}, deliveryTime: ${
        deliveryTime || "all"
      }`
    );
    const [results] = await pool.query(query, queryParams);
    console.log(`✅ Fetched ${results.length} orders from DB`);
    res.json({ orders: results });
  } catch (err) {
    console.error("❌ Error fetching orders:", err.message);
    res.status(500).json({ error: "Database error: " + err.message });
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
    console.error("❌ Error fetching order details:", err.message);
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

app.post("/api/order/:order_ref_number/update-status", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newStatus = req.body.status;
  const cancellationReason = req.body.cancellationReason;
  if (!newStatus || !["yes", "no"].includes(newStatus)) {
    console.log(
      `❌ Invalid status for order ${order_ref_number}: ${newStatus}`
    );
    return res.status(400).json({ error: "Invalid status" });
  }
  const updateSQL =
    "UPDATE testingTrialAcc SET status = ? WHERE order_ref_number = ?";
  try {
    console.log(
      `🔄 Updating status for order ${order_ref_number} to "${newStatus}"`
    );
    await pool.query(updateSQL, [newStatus, order_ref_number]);
    console.log(
      `✅ Updated status for order ${order_ref_number} to "${newStatus}"`
    );
    if (newStatus === "no" && cancellationReason) {
      const [orderResults] = await pool.query(
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
        [order_ref_number]
      );
      if (orderResults.length > 0) {
        await sendCancellationMessage(orderResults[0], cancellationReason);
      }
    }
    await emitOrdersUpdate(io, pool);
    res.json({ message: `Status updated to ${newStatus}` });
  } catch (err) {
    console.error(
      `❌ Error updating status for order ${order_ref_number}:`,
      err.message
    );
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

app.post("/api/order/:order_ref_number/update-delivery", async (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newDeliveryTime = parseInt(req.body.delivery_time);
  const delayReason = req.body.delayReason;
  if (isNaN(newDeliveryTime) || newDeliveryTime < 0) {
    console.log(
      `❌ Invalid delivery time for order ${order_ref_number}: ${newDeliveryTime}`
    );
    return res.status(400).json({ error: "Invalid delivery time" });
  }
  const updateSQL =
    "UPDATE testingTrialAcc SET delivery_time = ? WHERE order_ref_number = ?";
  try {
    console.log(
      `🔄 Updating delivery time for order ${order_ref_number} to ${newDeliveryTime}`
    );
    await pool.query(updateSQL, [newDeliveryTime, order_ref_number]);
    console.log(
      `✅ Updated delivery time for order ${order_ref_number} to ${newDeliveryTime}`
    );
    if (delayReason) {
      const [orderResults] = await pool.query(
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
        [order_ref_number]
      );
      if (orderResults.length > 0) {
        await sendDeliveryUpdateMessage(
          orderResults[0],
          newDeliveryTime,
          delayReason
        );
      }
    }
    await emitOrdersUpdate(io, pool);
    res.json({ message: `Delivery time updated to ${newDeliveryTime}` });
  } catch (err) {
    console.error(
      `❌ Error updating delivery time for order ${order_ref_number}:`,
      err.message
    );
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

// Serve Order Portal Frontend
app.get("/", (req, res) => {
  console.log("📄 Serving order portal frontend");
  res.sendFile(path.join(__dirname, "orderPortalSystem", "index.html"));
});

// WhatsApp Automation Routes
app.get("/api/status", (req, res) => {
  console.log("🔍 Health check requested");
  res.json({ status: "ok" });
});

app.get("/confirm/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`🔗 Order ${orderRef} confirmed via link`);
  try {
    await updateOrderStatusViaAPI(orderRef, "yes");
    await updateOrderStatusInDB(orderRef, "yes");
    console.log(`✅ Order ${orderRef} status set to 'yes' locally`);
  } catch (e) {
    console.error("❌ Error in confirm link flow:", e.message);
  }
  return res.sendFile(path.join(__dirname, "confirm.html"));
});

app.get("/reject/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`🔗 Order ${orderRef} rejected via link`);
  try {
    await updateOrderStatusViaAPI(orderRef, "no");
  } catch (e) {
    console.error("❌ Error updating via API:", e.message);
  }
  return res.sendFile(path.join(__dirname, "reject.html"));
});

app.get("/api/sendMessage/:phone", async (req, res) => {
  const phone = req.params.phone.trim();
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
      return res
        .status(404)
        .json({ error: "No order found for this phone number." });
    }
    const order = rows[0];
    const sent = await sendOrderConfirmationMessage(order);
    if (sent) {
      console.log(`✅ Manual message sent to ${phone}`);
      res.json({ message: "Confirmation message sent." });
    } else {
      console.log(`❌ Failed to send manual message to ${phone}`);
      res.status(500).json({ error: "Failed to send confirmation message." });
    }
  } catch (error) {
    console.error("❌ Error in manual send endpoint:", error.message);
    res.status(500).json({ error: "Internal server error: " + error.message });
  } finally {
    if (connection) connection.release();
  }
});

// Log uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err.message, err.stack);
});

// Log unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// Log Socket.IO connection events
io.on("connection", (socket) => {
  console.log(`🔗 Socket connected: ${socket.id}`);
  socket.on("disconnect", (reason) => {
    console.log(`🔗 Socket disconnected: ${socket.id}, Reason: ${reason}`);
  });
  socket.on("error", (error) => {
    console.error(`❌ Socket error: ${error.message}`);
  });
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Start periodic tasks
initializeWhatsAppClient()
  .then(() => {
    console.log("🔄 Starting periodic tasks...");
    processNewShopifyOrders();
    setInterval(processNewShopifyOrders, POLL_INTERVAL);
    setInterval(checkForResendMessages, RESEND_CHECK_INTERVAL);
    setInterval(() => syncShopifyOrders(pool), 10 * 60 * 1000); // Changed to 10 minutes
    setInterval(() => decrementDeliveryTimes(pool, io), 30 * 1000);
  })
  .catch((err) => {
    console.error("❌ Fatal: could not initialize WhatsApp client", err);
    process.exit(1);
  });

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("🔄 Gracefully shutting down...");
  if (waClient) {
    await waClient.destroy();
  }
  process.exit(0);
});
