import "dotenv/config";
import { db } from "./src/db.js";
await db.query("UPDATE masters SET schedule_anchor = NULL, work_days = NULL, off_days = NULL WHERE id = 1");
console.log("График временно убран");
process.exit(0);
