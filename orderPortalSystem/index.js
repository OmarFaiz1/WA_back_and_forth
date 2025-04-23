require("dotenv").config();
const mysql = require("mysql2/promise");

// Function: Emit updated orders to all clients (requires io from parent)
async function emitOrdersUpdate(io, pool) {
  const selectAll = `
    SELECT order_ref_number, customer_name, amount, status, delivery_time
    FROM testingTrialAcc
  `;
  try {
    const [results] = await pool.query(selectAll);
    io.emit("orders_update", results);
  } catch (err) {
    console.error("❌ Error fetching orders for real-time update:", err);
  }
}

// Function: Fetch orders from Shopify (sample data, replace with real fetch if needed)
async function fetchShopifyOrders() {
  return [
    {
      order_ref_number: "1001",
      customer_name: "John Doe",
      amount: 150,
      status: "yes",
      delivery_time: 3,
    },
  ];
}

// Function: Sync Shopify orders with the database
async function syncShopifyOrders(pool) {
  console.log("🔄 Running Shopify sync job...");
  try {
    const shopifyOrders = await fetchShopifyOrders();
    let newCount = 0,
      updatedCount = 0,
      unchangedCount = 0;

    const promises = shopifyOrders.map(async (order) => {
      const selectQuery =
        "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?";
      try {
        const [results] = await pool.query(selectQuery, [
          order.order_ref_number,
        ]);
        if (results.length > 0) {
          const currentRecord = results[0];
          const fieldsToCheck = [
            "customer_name",
            "amount",
            "status",
            "delivery_time",
          ];
          const updates = [];
          const params = [];
          fieldsToCheck.forEach((field) => {
            if (order[field] != currentRecord[field]) {
              updates.push(`${field} = ?`);
              params.push(order[field]);
            }
          });
          if (updates.length > 0) {
            const updateQuery = `UPDATE testingTrialAcc SET ${updates.join(
              ", "
            )} WHERE order_ref_number = ?`;
            params.push(order.order_ref_number);
            await pool.query(updateQuery, params);
            console.log(`✅ Updated order ${order.order_ref_number}`);
            updatedCount++;
          } else {
            console.log(`ℹ️ Unchanged order ${order.order_ref_number}`);
            unchangedCount++;
          }
        } else {
          const insertQuery = `
            INSERT INTO testingTrialAcc (order_ref_number, customer_name, amount, status, delivery_time)
            VALUES (?, ?, ?, ?, ?)
          `;
          await pool.query(insertQuery, [
            order.order_ref_number,
            order.customer_name,
            order.amount,
            order.status,
            order.delivery_time,
          ]);
          console.log(`✅ Inserted new order ${order.order_ref_number}`);
          newCount++;
        }
      } catch (err) {
        console.error(
          `❌ Error processing order ${order.order_ref_number}:`,
          err
        );
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
    console.error("❌ Fatal error in Shopify sync job:", err);
    throw err;
  }
}

// Function: Decrement delivery_time every 30 seconds
async function decrementDeliveryTimes(pool) {
  console.log("🔄 Running delivery time decrement job...");
  const updateQuery = `
    UPDATE testingTrialAcc
    SET delivery_time = delivery_time - 1
    WHERE status = 'yes' AND delivery_time > 0
  `;
  try {
    const [results] = await pool.query(updateQuery);
    console.log(
      `✅ Decremented delivery time for ${results.affectedRows} orders`
    );
  } catch (err) {
    console.error("❌ Error decrementing delivery times:", err);
  }
}

module.exports = {
  emitOrdersUpdate,
  syncShopifyOrders,
  decrementDeliveryTimes,
};
