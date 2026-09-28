process.env.BOT_TOKEN = "123456:FAKE_LOCAL_TEST_TOKEN";
import "dotenv/config";
import { db } from "./src/db.js";
const r = await db.query("SELECT id, starts_at::text, reminder_master_sent, now()::text AS n FROM bookings WHERE id = 131");
console.log(r.rows[0]);
process.exit(0);
