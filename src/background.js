// Entry point. The feature list lives in modules/index.js.

import { createKernel } from "./core/kernel.js";
import modules from "./modules/index.js";

const kernel = await createKernel({ api: browser, modules });

// Handy from the background page console: __grove.ctx.commands.list()
globalThis.__grove = kernel;

browser.runtime.onSuspend?.addListener(() => kernel.stop());
