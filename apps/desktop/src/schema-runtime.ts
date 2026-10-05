import { z } from "zod";

// Configure before shared schemas are constructed. Electron contexts and the
// supported macOS development launcher can prohibit dynamic code generation.
z.config({ jitless: true });
