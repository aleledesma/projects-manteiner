import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const configuredPath = process.env["DATABASE_PATH"] ?? "./data/manteiner.db";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      configuredPath === ":memory:" || isAbsolute(configuredPath)
        ? configuredPath
        : resolve(projectRoot, configuredPath),
  },
});
