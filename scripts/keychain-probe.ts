// Verifies the macOS Keychain works for this app in the current context by
// writing, reading and deleting one throwaway item. Uses the development
// service name, so real credentials are never touched.
// Usage: node scripts/keychain-probe.ts
import { createKeychainStore } from "../src/storage/credentials.ts";

const store = createKeychainStore("com.atelierhalle.media-manager.dev");
const result = await store.probe();
process.stdout.write(result.ok ? "Keychain OK: write, read and delete succeeded.\n" : `Keychain unavailable: ${result.reason}\n`);
process.exit(result.ok ? 0 : 1);
