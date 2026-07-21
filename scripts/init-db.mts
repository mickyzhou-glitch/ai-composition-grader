import path from "node:path";

import { openAppDatabase } from "../src/db/client.ts";

const databasePath = path.resolve(
  process.env.APP_DATABASE_PATH ?? ".data/app.db",
);
const database = openAppDatabase(databasePath);
database.close();

console.log(`Initialized SQLite database at ${databasePath}`);
