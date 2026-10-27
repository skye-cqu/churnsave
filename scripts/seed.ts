/**
 * Seed the local demo database: one merchant, three buyers with different
 * spending histories, no churn events yet.
 * Run:  npm run seed   (creates ./churnsave.db)
 */
import { ChurnStore } from "../src/db/store";
import { DEMO_BUYERS, seedDemoData } from "../src/db/seed-data";

const dbFile = process.env.CHURNSAVE_DB ?? "churnsave.db";
const store = ChurnStore.fromFile(dbFile);

seedDemoData(store);

console.log(`Seeded ${dbFile}:`);
for (const b of DEMO_BUYERS) {
  console.log(
    `  ${b.buyer_name.padEnd(12)} ${b.paypal_subscription_id.padEnd(22)} ${b.plan.padEnd(7)} $${b.monthly_price}/mo x ${b.payments} payments (LTV $${b.payments * b.amount})`,
  );
}
console.log("\nStart the app:  npm run dev   ->  http://localhost:3000");
store.close();
