import { configDefaults, defineConfig } from "vitest/config";
// ledger/ is a standalone package with its own deps and test run
export default defineConfig({ test: { environment: "node", exclude: [...configDefaults.exclude, "ledger/**"] } });
