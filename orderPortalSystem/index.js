require("dotenv").config();
const mysql = require("mysql2");

// MySQL Connection Pool (to be shared with eid-greetings.js)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Function: Emit updated orders to all clients (requires io from parent)
function emitOrdersUpdate(io) {
  const selectAll = `
    SELECT order_ref_number, customer_name, amount, status, delivery_time
    FROM testingTrialAcc
  `;
  pool.query(selectAll, (err, results) => {
    if (err) {
      console.error("❌ Error fetching orders for real-time update:", err);
      return;
    }
    io.emit("orders_update", results);
  });
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
async function syncShopifyOrders() {
  console.log("🔄 Running Shopify sync job...");
  try {
    const shopifyOrders = await fetchShopifyOrders();
    let newCount = 0,
      updatedCount = 0,
      unchangedCount = 0;

    const promises = shopifyOrders.map((order) => {
      return new Promise((resolve) => {
        const selectQuery =
          "SELECT * FROM testingTrialAcc WHERE order_ref_number = ?";
        pool.query(selectQuery, [order.order_ref_number], (err, results) => {
          if (err) {
            console.error(
              `❌ Error checking order ${order.order_ref_number}:`,
              err
            );
            return resolve();
          }
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
              pool.query(updateQuery, params, (updateErr) => {
                if (updateErr) {
                  console.error(
                    `❌ Error updating order ${order.order_ref_number}:`,
                    updateErr
                  );
                } else {
                  console.log(`✅ Updated order ${order.order_ref_number}`);
                  updatedCount++;
                }
                return resolve();
              });
            } else {
              console.log(`ℹ️ Unchanged order ${order.order_ref_number}`);
              unchangedCount++;
              return resolve();
            }
          } else {
            const insertQuery = `
              INSERT INTO testingTrialAcc (order_ref_number, customer_name, amount, status, delivery_time)
              VALUES (?, ?, ?, ?, ?)
            `;
            pool.query(
              insertQuery,
              [
                order.order_ref_number,
                order.customer_name,
                order.amount,
                order.status,
                order.delivery_time,
              ],
              (insertErr) => {
                if (insertErr) {
                  console.error(
                    `❌ Error inserting order ${order.order_ref_number}:`,
                    insertErr
                  );
                } else {
                  console.log(
                    `✅ Inserted new order ${order.order_ref_number}`
                  );
                  newCount++;
                }
                return resolve();
              }
            );
          }
        });
      });
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
function decrementDeliveryTimes() {
  console.log("🔄 Running delivery time decrement job...");
  const updateQuery = `
    UPDATE testingTrialAcc
    SET delivery_time = delivery_time - 1
    WHERE status = 'yes' AND delivery_time > 0
  `;
  pool.query(updateQuery, (err, results) => {
    if (err) {
      console.error("❌ Error decrementing delivery times:", err);
      return;
    }
    console.log(
      `✅ Decremented delivery time for ${results.affectedRows} orders`
    );
  });
}

module.exports = {
  pool,
  emitOrdersUpdate,
  syncShopifyOrders,
  decrementDeliveryTimes,
};
