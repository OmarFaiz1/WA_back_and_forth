require("dotenv").config();
const mysql = require("mysql2/promise");
const fetch = require("node-fetch");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// WhatsApp Client Setup
let isClientReady = false;
const waClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

waClient.on("qr", (qr) => {
  console.log("📱 WhatsApp QR code for authentication:");
  qrcode.generate(qr, { small: true });
});

waClient.on("authenticated", () => {
  console.log("✅ WhatsApp client authenticated");
});

waClient.on("ready", () => {
  console.log("✅ WhatsApp client is ready!");
  isClientReady = true;
});

waClient.on("disconnected", (reason) => {
  console.log(`❌ WhatsApp client disconnected: ${reason}`);
  isClientReady = false;
  waClient.initialize();
});

waClient.initialize().catch((err) => {
  console.error("❌ Failed to initialize WhatsApp client:", err);
});

// Helper: Wait for WhatsApp client to be ready
async function waitForClientReady(timeout = 60000) {
  const startTime = Date.now();
  while (!isClientReady) {
    if (Date.now() - startTime > timeout) {
      throw new Error("WhatsApp client not ready within timeout period");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Helper: Convert phone number to WhatsApp-compatible format
function convertPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  // Assuming Pakistan numbers: prepend country code "92" if missing
  if (!cleaned.startsWith("92")) {
    return "92" + cleaned.slice(1);
  }
  return cleaned;
}

// Function: Send WhatsApp order confirmation message
async function sendOrderConfirmationMessage(order, connection) {
  if (!order.phone) {
    console.warn(`⚠️ Skipping confirmation message for order ${order.order_ref_number}: No phone number available`);
    return false;
  }

  const waId = convertPhone(order.phone);
  if (!waId) {
    console.warn(`⚠️ Skipping confirmation message for order ${order.order_ref_number}: Invalid phone number ${order.phone}`);
    return false;
  }

  const confirmUrl = `${process.env.BASE_URL}/api/order/${order.order_ref_number}/confirm`;
  const rejectUrl = `${process.env.BASE_URL}/api/order/${order.order_ref_number}/reject`;

  const MESSAGE_TEXT_TEMPLATE = `🛒 *Order Confirmation*\nDear ${order.customer_name || "Customer"},\nYour order (Ref: ${order.order_ref_number}) amounting to PKR ${order.amount || "0.00"} is ready to be confirmed.\n\nPlease confirm your order here: ${confirmUrl}\nTo reject, click here: ${rejectUrl}\n\nThank you for shopping with us!`;

  try {
    console.log(`📩 Preparing to send confirmation message to ${waId} for order ${order.order_ref_number}`);
    await waitForClientReady();
    const messageText = MESSAGE_TEXT_TEMPLATE;

    let sentMessage = null;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        sentMessage = await waClient.sendMessage(`${waId}@c.us`, messageText);
        console.log(`✅ Confirmation message sent successfully to ${waId} for order ${order.order_ref_number}`);
        break;
      } catch (err) {
        console.error(`❌ Attempt ${attempt} failed to send message to ${waId}: ${err.message}`);
        if (attempt === maxRetries) {
          console.error(`❌ Failed to send confirmation message to ${waId} after ${maxRetries} attempts`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }

    // Log detailed response
    console.log(`Message sent status for ${waId}:`, sentMessage ? "Success" : "Failed", "Response:", sentMessage);

    // Update database to mark message as sent
    const updateQuery = `
      UPDATE testingTrialAcc
      SET message_sent = 1
      WHERE order_ref_number = ?
    `;
    await connection.query(updateQuery, [order.order_ref_number]);
    console.log(`✅ Updated database: message_sent set to 1 for order ${order.order_ref_number}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send confirmation message for order ${order.order_ref_number}: ${err.message}`);
    return false;
  }
}

// Function: Emit updated orders to all clients (requires io from parent)
async function emitOrdersUpdate(io, pool) {
  let connection;
  try {
    console.log("📢 Preparing to emit orders update...");
    connection = await pool.getConnection();
    const selectAll = `
      SELECT order_ref_number, customer_name, amount, status, delivery_time, phone, city, custom_note
      FROM testingTrialAcc
    `;
    const [results] = await connection.query(selectAll);
    console.log(`✅ Emitting ${results.length} orders to all clients`);
    io.emit("orders_update", results);
  } catch (err) {
    console.error(`❌ Error fetching orders for real-time update: ${err.message}`);
  } finally {
    if (connection) connection.release();
  }
}

// Function: Fetch orders from Shopify with search and delivery filter
async function fetchShopifyOrders(searchQuery = "", deliveryTime = null) {
  console.log(`🔄 Fetching orders from Shopify with deliveryTime: ${deliveryTime || "none"}...`);
  try {
    let url = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-07/orders.json?status=any`;
    if (searchQuery) {
      url += `&query=${encodeURIComponent(searchQuery)}`;
    }
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const data = await response.json();
    let orders = data.orders.map((order, index) => ({
      order_ref_number: order.id ? order.id.toString() : `unknown_${index}`,
      customer_name: order.customer
        ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim() || "Unknown"
        : "Unknown",
      amount: parseFloat(order.total_price) || 0.0,
      status: order.financial_status === "paid" ? "yes" : "no",
      delivery_time: Math.floor(Math.random() * 10) + 1,
      phone: order.customer?.phone || null,
      city: order.shipping_address?.city || null,
      custom_note: order.note || null,
    }));

    if (deliveryTime !== null && !isNaN(deliveryTime)) {
      const exactDeliveryTime = parseInt(deliveryTime);
      orders = orders.filter(order => order.delivery_time === exactDeliveryTime);
      console.log(`🔍 Filtered orders to ${orders.length} with delivery_time = ${exactDeliveryTime}`);
    }

    console.log(`✅ Fetched ${orders.length} orders from Shopify after filtering`);
    return orders;
  } catch (error) {
    console.error(`❌ Error fetching Shopify orders: ${error.message}`);
    return [];
  }
}

// Function: Fetch Shopify order line items for a specific order
async function fetchShopifyOrderLineItems(order_ref_number) {
  try {
    const url = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-07/orders/${order_ref_number}.json`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const data = await response.json();
    const order = data.order;
    const lineItems = order.line_items.map(item => ({
      title: item.title,
      quantity: item.quantity,
      price: item.price,
    }));
    return lineItems;
  } catch (error) {
    console.error(`❌ Error fetching Shopify order line items for ${order_ref_number}: ${error.message}`);
    return [];
  }
}

// Function: Sync Shopify orders with the database and send WhatsApp messages
async function syncShopifyOrders(pool, searchQuery = "", deliveryTime = null) {
  let connection;
  console.log("🔄 Running Shopify sync job...");
  try {
    connection = await pool.getConnection();
    const shopifyOrders = await fetchShopifyOrders(searchQuery, deliveryTime);
    let newCount = 0, updatedCount = 0, unchangedCount = 0;

    const promises = shopifyOrders.map(async (order) => {
      const selectQuery = "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?";
      try {
        const [results] = await connection.query(selectQuery, [order.order_ref_number]);
        if (results.length > 0) {
          const currentRecord = results[0];
          const fieldsToCheck = ["customer_name", "amount", "status", "delivery_time", "phone", "city", "custom_note"];
          const updates = [];
          const params = [];
          fieldsToCheck.forEach((field) => {
            if (order[field] !== currentRecord[field]) {
              updates.push(`${field} = ?`);
              params.push(order[field]);
            }
          });
          if (updates.length > 0) {
            const updateQuery = `UPDATE testingTrialAcc SET ${updates.join(", ")} WHERE order_ref_number = ?`;
            params.push(order.order_ref_number);
            await connection.query(updateQuery, params);
            console.log(`✅ Updated order ${order.order_ref_number}`);
            updatedCount++;
          } else {
            console.log(`ℹ️ Unchanged order ${order.order_ref_number}`);
            unchangedCount++;
          }
        } else {
          const insertQuery = `
            INSERT INTO testingTrialAcc (order_ref_number, customer_name, amount, status, delivery_time, phone, city, custom_note, message_sent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
          `;
          await connection.query(insertQuery, [
            order.order_ref_number,
            order.customer_name,
            order.amount,
            order.status,
            order.delivery_time,
            order.phone,
            order.city,
            order.custom_note,
          ]);
          console.log(`✅ Inserted new order ${order.order_ref_number}`);
          newCount++;

          // Send WhatsApp confirmation message for new orders
          if (order.phone) {
            const sent = await sendOrderConfirmationMessage(order, connection);
            if (!sent) {
              console.warn(`⚠️ Failed to send confirmation for order ${order.order_ref_number}: Phone ${order.phone} may be invalid`);
            }
          } else {
            console.warn(`⚠️ Skipping confirmation message for order ${order.order_ref_number}: No phone number available`);
          }
        }
      } catch (err) {
        console.error(`❌ Error processing order ${order.order_ref_number}: ${err.message}`);
      }
    });

    await Promise.all(promises);
    console.log("----- Shopify Sync Summary -----");
    console.log(`Total orders processed: ${shopifyOrders.length}`);
    console.log(`New orders inserted: ${newCount}`);
    console.log(`Orders updated: ${updatedCount}`);
    console.log(`Orders unchanged: ${unchangedCount}`);
    console.log("----- End of Summary -----");
  } catch (err) {
    console.error(`❌ Fatal error in Shopify sync job: ${err.message}`);
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

// Function: Decrement delivery_time every 30 seconds
async function decrementDeliveryTimes(pool, io) {
  let connection;
  console.log("🔄 Running delivery time decrement job...");
  try {
    connection = await pool.getConnection();
    const updateQuery = `
      UPDATE testingTrialAcc
      SET delivery_time = GREATEST(delivery_time - 1, 0)
      WHERE status = 'yes' AND delivery_time > 0
    `;
    const [results] = await connection.query(updateQuery);
    console.log(`✅ Decremented delivery time for ${results.affectedRows || 0} orders`);
    await emitOrdersUpdate(io, pool);
  } catch (err) {
    console.error(`❌ Error decrementing delivery times: ${err.message}`);
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  emitOrdersUpdate,
  syncShopifyOrders,
  decrementDeliveryTimes,
  fetchShopifyOrderLineItems,
};