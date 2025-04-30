require("dotenv").config();
const mysql = require("mysql2/promise");
const fetch = require("node-fetch");

// Function: Emit updated orders to all clients (requires io from parent)
async function emitOrdersUpdate(io, pool) {
  let connection;
  try {
    console.log("📢 Preparing to emit orders update...");
    connection = await pool.getConnection();
    const selectAll = `
      SELECT order_ref_number, customer_name, amount, status, delivery_time
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

// Function: Fetch orders from Shopify using Admin API
async function fetchShopifyOrders() {
  console.log("🔄 Fetching orders from Shopify...");
  try {
    const url = `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2023-10/orders.json?status=any`;
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
    const orders = data.orders.map((order) => ({
      order_ref_number: order.id.toString(),
      customer_name: order.customer
        ? `${order.customer.first_name} ${order.customer.last_name}`
        : "Unknown",
      amount: parseFloat(order.total_price),
      status: order.financial_status === "paid" ? "yes" : "no",
      delivery_time: Math.floor(Math.random() * 10) + 1, // Placeholder; replace with actual logic
      phone: order.customer?.phone || null,
      city: order.shipping_address?.city || null,
      custom_note: order.note || null,
    }));
    console.log(`✅ Fetched ${orders.length} orders from Shopify`);
    return orders;
  } catch (error) {
    console.error(`❌ Error fetching Shopify orders: ${error.message}`);
    return [];
  }
}

// Function: Sync Shopify orders with the database
async function syncShopifyOrders(pool) {
  let connection;
  console.log("🔄 Running Shopify sync job...");
  try {
    connection = await pool.getConnection();
    const shopifyOrders = await fetchShopifyOrders();
    let newCount = 0,
      updatedCount = 0,
      unchangedCount = 0;

    const promises = shopifyOrders.map(async (order) => {
      const selectQuery = "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?";
      try {
        const [results] = await connection.query(selectQuery, [order.order_ref_number]);
        if (results.length > 0) {
          const currentRecord = results[0];
          const fieldsToCheck = [
            "customer_name",
            "amount",
            "status",
            "delivery_time",
            "phone",
            "city",
            "custom_note",
          ];
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
            INSERT INTO testingTrialAcc (order_ref_number, customer_name, amount, status, delivery_time, phone, city, custom_note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
};
