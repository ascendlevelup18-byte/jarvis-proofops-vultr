// Measures the policy schema from apps/proofops/src/policy.ts on oversized input. Run from the repo root: node --expose-gc proof/release-20261105/zod-advisory-test.mjs "$PWD"
import { createRequire } from "node:module";
const R=process.argv[2]; const require=createRequire(R+"/package.json");
const {version}=JSON.parse((await import("node:fs")).readFileSync(R+"/node_modules/zod/package.json","utf8"));
const {z}=require("zod");
const Action=z.discriminatedUnion("tool",[
 z.object({tool:z.literal("navigate"),path:z.string().max(256),reason:z.string().max(300).optional()}).strict(),
 z.object({tool:z.literal("click"),ref:z.string().regex(/^e\d{1,4}$/),epoch:z.number().int().nonnegative(),reason:z.string().max(300).optional()}).strict(),
 z.object({tool:z.literal("fill"),ref:z.string().regex(/^e\d{1,4}$/),epoch:z.number().int().nonnegative(),value:z.string().max(64),reason:z.string().max(300).optional()}).strict(),
 z.object({tool:z.literal("request_approval"),ref:z.string().regex(/^e\d{1,4}$/),epoch:z.number().int().nonnegative(),reason:z.string().max(300).optional()}).strict(),
 z.object({tool:z.literal("finish"),note:z.string().max(500).optional()}).strict()]);
const big=Array(2_000_000).fill(0); const keys=Object.fromEntries(Array.from({length:500_000},(_,i)=>["k"+i,0]));
const cases={ "top-level array":big, "array in path":{tool:"navigate",path:big}, "array in reason":{tool:"finish",note:big}, "array as tool":{tool:big}, "500k extra keys":{tool:"finish",...keys}, "5MB string":{tool:"finish",note:"x".repeat(5e6)} , "control: vulnerable shape z.array(uuid)":null};
const run=(n,fn)=>{global.gc?.();const h0=process.memoryUsage().heapUsed;const t=performance.now();const r=fn();const ms=performance.now()-t;const h1=process.memoryUsage().heapUsed;console.log(`${n.padEnd(42)} ${r.success?"ok":"rejected"} issues=${r.success?0:r.error.issues.length} ${ms.toFixed(1)}ms heap+${((h1-h0)/1e6).toFixed(1)}MB`)};
console.log("zod",version);
for(const [n,v] of Object.entries(cases)){ if(v) run(n,()=>Action.safeParse(v)); }
run("control: z.array(z.string().uuid()) 2M",()=>z.array(z.string().uuid()).safeParse(big));
