// Emit the stable bin entry `dist/main.js`. tsc roots the compilation at the repo
// root (the server imports the CLI's config resolution and the collector's token
// helpers by source path), so the real entry lands at `dist/mcp/src/main.js`; this
// two-line shim gives callers a short, stable path (`mcp/dist/main.js`) and carries
// the shebang the `bin` symlink needs.
import { writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../dist/main.js', import.meta.url));
writeFileSync(target, "#!/usr/bin/env node\nimport './mcp/src/main.js';\n");
chmodSync(target, 0o755);
