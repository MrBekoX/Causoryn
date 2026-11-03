/**
 * Node ESM resolve-hook kaydı: child process'i `--import` ile bu dosyaya
 * veririz; hook, TS kaynak ağacındaki `./x.js` import specifi'lerini
 * `./x.ts` dosyalarına eşler (Node 24 yerel type-stripping `.js→.ts`
 * yeniden yazımı yapmaz). Yalnızca test altyapısıdır.
 */
import { register } from "node:module";

register(new URL("./strip-loader.mjs", import.meta.url));
