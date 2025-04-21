/**
 * Automated Order Confirmation with Shopify, MySQL, WhatsApp Messaging and Manual Endpoint.
 *
 * This code:
 * - Checks for new orders from Shopify via its REST API.
 * - Inserts new orders into the "testingTrialAcc" table.
 * - Sends an automated WhatsApp confirmation message to the customer.
 * - Rechecks orders every minute (or hourly in production) to resend the message if 4 hours have passed
 *   and the order status is still 'no'. It then increments the lastMessageSent counter.
 * - Exposes an endpoint to manually resend the message by phone number.
 */

require("dotenv").config();
const path = require("path");
// serve static HTML pages from project root
apiApp.use(express.static(__dirname));
const express = require("express");
const mysql = require("mysql2/promise");
const axios = require("axios");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const apiApp = express();
apiApp.use(express.json());
const BASE_URL = process.env.APP_BASE_URL || "https://your-app.herokuapp.com";

// -----------------------------------------------------------------------------
// Configuration – load from .env or use defaults

const PORT = process.env.API_PORT || 3001;
const POLL_INTERVAL = process.env.POLL_INTERVAL || 60000; // check Shopify orders every 60 seconds
const RESEND_CHECK_INTERVAL = process.env.RESEND_CHECK_INTERVAL || 3600000; // check every minute for demo (use 3600000 for hourly)
const RESEND_HOURS_THRESHOLD = 4; // resend if 4 hours have passed

// Shopify credentials and details
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "aezenai.myshopify.com";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";
const SHOPIFY_ACCESS_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN || "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";

// DB credentials (from your provided information)
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

// Automated message content – you can further customize this as needed.
// Automated message content – now showing two “button” links
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

// -----------------------------------------------------------------------------
// Initialize MySQL connection pool
const pool = mysql.createPool(DB_CONFIG);

// -----------------------------------------------------------------------------
// WhatsApp client initialization
let waClient = null;

async function initializeWhatsAppClient() {
  if (waClient) return;
  console.log("Initializing WhatsApp client...");
  waClient = new Client({
    authStrategy: new LocalAuth({
      clientId: "order-confirmation-sender",
      dataPath: "./.wwebjs_auth", // ensure this folder is writable
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
    qrcode.generate(qr, { small: true });
  });

  waClient.on("authenticated", () => {
    console.log("WhatsApp authenticated successfully.");
  });

  waClient.on("auth_failure", (msg) => {
    console.error("WhatsApp authentication failure:", msg);
    process.exit(1);
  });

  waClient.on("ready", () => {
    console.log("WhatsApp client is ready.");
  });

  waClient.initialize();
}

// -----------------------------------------------------------------------------
// Utility: Convert phone number – if it begins with "0", change it to start with "92"
function convertPhone(phone) {
  if (phone.startsWith("0")) {
    return "92" + phone.slice(1);
  }
  return phone; // if already starts with 92 or other pattern, assume it's correct
}

// -----------------------------------------------------------------------------
// Function to send order confirmation message via WhatsApp
async function sendOrderConfirmationMessage(order) {
  try {
    // Convert phone number if necessary
    let phone = order.phone.trim();
    phone = convertPhone(phone);

    // Build WhatsApp contact id
    const waId = `${phone}@c.us`;
    const contact = {
      id: { user: phone, _serialized: waId },
      name: order.customer_name || "Customer",
    };

    // Build the message text with order details
    const messageText = MESSAGE_TEXT_TEMPLATE(order);
    console.log(`Sending confirmation message to ${contact.id.user}...`);

    // Send message via WhatsApp client
    const sentMessage = await waClient.sendMessage(
      contact.id._serialized,
      messageText
    );
    if (sentMessage) {
      console.log(`Message sent to ${contact.id.user}`);
      // Update the DB: mark messageSent as 'yes'
      await updateOrderMessageSent(order.order_ref_number);
      // Start listening for reply for this order
      listenForOrderReply(contact, order);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error sending message:", error.message);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Listen for immediate reply for a specific order
function listenForOrderReply(contact, order) {
  const replyListener = (message) => {
    if (message.from === contact.id._serialized) {
      const reply = message.body.toLowerCase();
      if (reply === "yes" || reply === "no") {
        console.log(
          `Received reply for order ${order.order_ref_number}: "${reply}"`
        );
        // Upon receiving reply, update order status via REST endpoint
        updateOrderStatusViaAPI(order.order_ref_number, reply);
        // Also update the database order record to store status immediately
        updateOrderStatusInDB(order.order_ref_number, reply);
        waClient.off("message", replyListener);
      }
    }
  };

  waClient.on("message", replyListener);
  // Stop listening after a timeout (using 1 minute here)
  setTimeout(() => {
    waClient.off("message", replyListener);
    console.log(
      `Stopped listening for reply for order ${order.order_ref_number}`
    );
  }, 60000);
}

// -----------------------------------------------------------------------------
// Function to update order status in the DB
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

// -----------------------------------------------------------------------------
// Function to mark that the confirmation message has been sent.
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

// -----------------------------------------------------------------------------
// Function to increment the lastMessageSent counter by 1
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

// -----------------------------------------------------------------------------
// Function to call the external REST API to update order status
async function updateOrderStatusViaAPI(orderRefNumber, status) {
  const apiBaseUrl = "https://testingorderportal.onrender.com/api";
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

// -----------------------------------------------------------------------------
// Function to fetch Shopify orders via their REST API
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

// -----------------------------------------------------------------------------
// Insert new Shopify order into testingTrialAcc (if it does not exist)
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
      // Assume order.order_number is our unique reference
      // You may need to adjust the mapping based on your shopify order structure.
      const orderRefNumber = order.order_number;
      // Check if order already exists in the DB table
      const [rows] = await connection.query(
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?",
        [orderRefNumber]
      );
      if (rows.length === 0) {
        // Map Shopify order to our DB schema – adjust field mapping as needed.
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
          status: "no", // waiting confirmation
          delivery_time: 4,
          messageSent: "no",
          lastMessageSent: 0,
        };

        // Insert order into DB
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
        // Send automated message
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

// -----------------------------------------------------------------------------
// Periodic check to resend confirmation messages if necessary.
// For each order whose status is still "no", if (lastMessageSent % RESEND_HOURS_THRESHOLD === 0)
// then resend the confirmation message.
async function checkForResendMessages() {
  let connection;
  try {
    connection = await pool.getConnection();
    const [orders] = await connection.query(
      "SELECT * FROM testingTrialAcc WHERE status = 'no'"
    );
    for (const order of orders) {
      // Here lastMessageSent represents how many hours have passed since the initial send.
      // If it is greater than 0 and a multiple of RESEND_HOURS_THRESHOLD, then send again.
      if (
        order.messageSent === "yes" &&
        order.lastMessageSent >= RESEND_HOURS_THRESHOLD
      ) {
        console.log(
          `Resending confirmation message for order ${order.order_ref_number}`
        );
        const updated = await sendOrderConfirmationMessage(order);
        if (updated) {
          // Reset the counter after resending or increment by 1 (as per your requirement)
          // Here we choose to increment to indicate another hour mark.
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

// -----------------------------------------------------------------------------
// Express API Server


// Health-check endpoint
apiApp.get("/api/status", (req, res) => {
  res.json({ status: "ok" });
});

apiApp.get("/confirm/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`Order ${orderRef} confirmed via link`);
  // fire off your existing API‐update function
  try {
    await updateOrderStatusViaAPI(orderRef, "yes");
  } catch (e) {
    console.error("Error updating via API:", e);
  }
  res.sendFile(path.join(__dirname, "confirm.html"));
});

// Rejection link
apiApp.get("/reject/:orderRef", async (req, res) => {
  const { orderRef } = req.params;
  console.log(`Order ${orderRef} rejected via link`);
  try {
    await updateOrderStatusViaAPI(orderRef, "no");
  } catch (e) {
    console.error("Error updating via API:", e);
  }
  res.sendFile(path.join(__dirname, "reject.html"));
});

// Manual endpoint: trigger automated message sending to a user via phone number.
// The phone number should start with 92 when provided in the URL.
apiApp.get("/api/sendMessage/:phone", async (req, res) => {
  const phone = req.params.phone.trim();
  if (!phone.startsWith("92")) {
    return res.status(400).json({ error: "Phone number must start with 92." });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    // Find the latest order for this phone number (assuming there could be multiple orders).
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

// Start Express server
apiApp.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

// -----------------------------------------------------------------------------
// Start main loops

// Initialize WhatsApp client then start periodic tasks.
initializeWhatsAppClient().then(() => {
  // Check Shopify orders on a regular interval
  setInterval(processNewShopifyOrders, POLL_INTERVAL);

  // Check for orders that need a resend of the confirmation message
  setInterval(checkForResendMessages, RESEND_CHECK_INTERVAL);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...");
  if (waClient) {
    await waClient.destroy();
  }
  process.exit(0);
});
