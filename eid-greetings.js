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
const {
  emitOrdersUpdate,
  syncShopifyOrders,
  decrementDeliveryTimes,
} = require("./orderPortalSystem/index.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

const BASE_URL = "https://your-render-app.onrender.com"; // Replace with your Render URL

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

// Initialize MySQL connection pool
const pool = mysql.createPool(DB_CONFIG);

// WhatsApp client initialization
let waClient = null;

async function initializeWhatsAppClient() {
  if (waClient) return;
  return new Promise((resolve, reject) => {
    console.log("Initializing WhatsApp client...");
    waClient = new Client({
      authStrategy: new LocalAuth({
        clientId: "order-confirmation-sender",
        dataPath: "./.wwebjs_auth",
      }),
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
        ],
      },
    });

    waClient.on("qr", (qr) => {
      console.log("Scan the QR code to authenticate WhatsApp:");
      qrcode.generate(qr, { small: false, margin: 2 });
    });

    waClient.on("authenticated", () => {
      console.log("WhatsApp authenticated successfully.");
    });

    waClient.on("auth_failure", (msg) => {
      console.error("WhatsApp auth failure:", msg);
      reject(new Error("WhatsApp auth failure"));
    });

    waClient.on("ready", () => {
      console.log("✅ WhatsApp client is ready.");
      resolve();
    });

    waClient.initialize();
  });
}

// Utility: Convert phone number
function convertPhone(phone) {
  if (phone.startsWith("0")) {
    return "92" + phone.slice(1);
  }
  return phone;
}

// Send order confirmation message
async function sendOrderConfirmationMessage(order) {
  try {
    let phone = order.phone.trim();
    phone = convertPhone(phone);
    const waId = `${phone}@c.us`;
    const contact = {
      id: { user: phone, _serialized: waId },
      name: order.customer_name || "Customer",
    };
    const messageText = MESSAGE_TEXT_TEMPLATE(order);
    console.log(`Sending confirmation message to ${contact.id.user}...`);
    const sentMessage = await waClient.sendMessage(
      contact.id._serialized,
      messageText
    );
    if (sentMessage) {
      console.log(`Message sent to ${contact.id.user}`);
      await updateOrderMessageSent(order.order_ref_number);
      listenForOrderReply(contact, order);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error sending message:", error.message);
    return false;
  }
}

// Listen for order reply
function listenForOrderReply(contact, order) {
  const replyListener = (message) => {
    if (message.from === contact.id._serialized) {
      const reply = message.body.toLowerCase();
      if (reply === "yes" || reply === "no") {
        console.log(
          `Received reply for order ${order.order_ref_number}: "${reply}"`
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
      `Stopped listening for reply for order ${order.order_ref_number}`
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
      `Order ${orderRefNumber} status updated in DB to "${newStatus}"`
    );
  } catch (error) {
    console.error(
      `Error updating order ${orderRefNumber} status in DB:`,
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
  } catch (error) {
    console.error(
      `Error updating messageSent for order ${orderRefNumber}:`,
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
    console.log(`Incremented lastMessageSent for order ${orderRefNumber}`);
  } catch (error) {
    console.error(
      `Error incrementing lastMessageSent for order ${orderRefNumber}:`,
      error.message
    );
  } finally {
    if (connection) connection.release();
  }
}

// Update order status via API (self-referencing now)
async function updateOrderStatusViaAPI(orderRefNumber, status) {
  const apiBaseUrl = BASE_URL + "/api";
  const apiKey = process.env.API_KEY || "fastians";
  try {
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
      `Order ${orderRefNumber} status updated via API:`,
      response.data
    );
  } catch (error) {
    console.error(
      `Error updating status for order ${orderRefNumber} via API:`,
      error.response ? error.response.data : error.message
    );
  }
}

// Fetch Shopify orders
async function fetchShopifyOrders() {
  try {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any`;
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });
    if (response.data && response.data.orders) {
      return response.data.orders;
    }
    return [];
  } catch (error) {
    console.error("Error fetching Shopify orders:", error.message);
    return [];
  }
}

// Process new Shopify orders
async function processNewShopifyOrders() {
  let connection;
  try {
    const orders = await fetchShopifyOrders();
    if (!orders.length) {
      console.log("No Shopify orders fetched.");
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
        console.log(`Inserted new order ${orderRefNumber} into DB.`);
        sendOrderConfirmationMessage(insertData);
      } else {
        console.log(`Order ${orderRefNumber} already exists in DB.`);
      }
    }
  } catch (error) {
    console.error("Error processing Shopify orders:", error.message);
  } finally {
    if (connection) connection.release();
  }
}

// Check for resend messages
async function checkForResendMessages() {
  let connection;
  try {
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
          `Resending confirmation message for order ${order.order_ref_number}`
        );
        const updated = await sendOrderConfirmationMessage(order);
        if (updated) {
          await incrementLastMessageCounter(order.order_ref_number);
        }
      }
    }
  } catch (error) {
    console.error("Error checking orders for resend:", error.message);
  } finally {
    if (connection) connection.release();
  }
}

// Order Portal Routes
app.get("/api/orders", (req, res) => {
  const filter = req.query.filter || "all";
  let query = `
    SELECT order_ref_number, customer_name, amount, status, delivery_time 
    FROM testingTrialAcc
  `;
  if (filter === "pending") {
    query += " WHERE status = 'yes' AND delivery_time > 0";
  } else if (filter === "completed") {
    query += " WHERE status = 'yes' AND delivery_time = 0";
  } else if (filter === "rejected") {
    query += " WHERE status = 'no'";
  }
  pool.query(query, (err, results) => {
    if (err) {
      console.error("❌ Error fetching orders:", err);
      return res.status(500).json({ error: "Database error" });
    }
    console.log(`✅ Fetched orders with filter: ${filter}`);
    res.json({ orders: results });
  });
});

app.get("/api/order/:order_ref_number", (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const query = `
    SELECT order_ref_number, customer_name, phone, amount, status, delivery_time, city
    FROM testingTrialAcc 
    WHERE order_ref_number = ?
  `;
  pool.query(query, [order_ref_number], (err, results) => {
    if (err) {
      console.error("❌ Error fetching order details:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    console.log(`✅ Fetched details for order ${order_ref_number}`);
    res.json({ order: results[0] });
  });
});

app.post("/api/order/:order_ref_number/update-status", (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newStatus = req.body.status;
  if (!newStatus || !["yes", "no"].includes(newStatus)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const updateSQL =
    "UPDATE testingTrialAcc SET status = ? WHERE order_ref_number = ?";
  pool.query(updateSQL, [newStatus, order_ref_number], (err, results) => {
    if (err) {
      console.error(
        `❌ Error updating status for order ${order_ref_number}:`,
        err
      );
      return res.status(500).json({ error: "Database error" });
    }
    console.log(
      `✅ Updated status for order ${order_ref_number} to ${newStatus}`
    );
    emitOrdersUpdate(io);
    res.json({ message: `Status updated to ${newStatus}` });
  });
});

app.post("/api/order/:order_ref_number/update-delivery", (req, res) => {
  const order_ref_number = req.params.order_ref_number;
  const newDeliveryTime = parseInt(req.body.delivery_time);
  if (isNaN(newDeliveryTime) || newDeliveryTime < 0) {
    return res.status(400).json({ error: "Invalid delivery time" });
  }
  const updateSQL =
    "UPDATE testingTrialAcc SET delivery_time = ? WHERE order_ref_number = ?";
  pool.query(updateSQL, [newDeliveryTime, order_ref_number], (err, results) => {
    if (err) {
      console.error(
        `❌ Error updating delivery time for order ${order_ref_number}:`,
        err
      );
      return res.status(500).json({ error: "Database error" });
    }
    console.log(
      `✅ Updated delivery time for order ${order_ref_number} to ${newDeliveryTime}`
    );
    emitOrdersUpdate(io);
    res.json({ message: `Delivery time updated to ${newDeliveryTime}` });
  });
});

// Serve Order Portal Frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "orderPortalSystem", "index.html"));
});

// WhatsApp Automation Routes
app.get("/api/status", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/confirm/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`Order ${orderRef} confirmed via link`);
  try {
    await updateOrderStatusViaAPI(orderRef, "yes");
    await updateOrderStatusInDB(orderRef, "yes");
    console.log(`Order ${orderRef} status set to 'yes' locally.`);
  } catch (e) {
    console.error("Error in confirm link flow:", e);
  }
  res.sendFile(path.join(__dirname, "confirm.html"));
});

app.get("/reject/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`Order ${orderRef} rejected via link`);
  try {
    await updateOrderStatusViaAPI(orderRef, "no");
  } catch (e) {
    console.error("Error updating via API:", e);
  }
  res.sendFile(path.join(__dirname, "reject.html"));
});

app.get("/api/sendMessage/:phone", async (req, res) => {
  const phone = req.params.phone.trim();
  if (!phone.startsWith("92")) {
    return res.status(400).json({ error: "Phone number must start with 92." });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE phone LIKE ? ORDER BY order_ref_number DESC LIMIT 1",
      [phone + "%"]
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No order found for this phone number." });
    }
    const order = rows[0];
    const sent = await sendOrderConfirmationMessage(order);
    if (sent) {
      res.json({ message: "Confirmation message sent." });
    } else {
      res.status(500).json({ error: "Failed to send confirmation message." });
    }
  } catch (error) {
    console.error("Error in manual send endpoint:", error.message);
    res.status(500).json({ error: "Internal server error." });
  } finally {
    if (connection) connection.release();
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Start periodic tasks
initializeWhatsAppClient()
  .then(() => {
    processNewShopifyOrders();
    setInterval(processNewShopifyOrders, POLL_INTERVAL);
    setInterval(checkForResendMessages, RESEND_CHECK_INTERVAL);
    setInterval(syncShopifyOrders, 5 * 60 * 1000);
    setInterval(decrementDeliveryTimes, 30 * 1000);
  })
  .catch((err) => {
    console.error("Fatal: could not initialize WhatsApp client", err);
    process.exit(1);
  });

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...");
  if (waClient) {
    await waClient.destroy();
  }
  process.exit(0);
});
