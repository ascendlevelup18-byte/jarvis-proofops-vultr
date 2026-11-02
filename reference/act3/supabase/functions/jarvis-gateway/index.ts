// JARVIS cloud gateway Edge Function. Routes: /team, /cases, /status (members) and /admin-health (platform
// admins). All logic lives in ../_shared/gateway.ts and is tested under Node (apps/api/test/cloud-gateway.test.ts).
import { route } from "../_shared/gateway.ts";
import { denoDeps } from "../_shared/supabase-deps.ts";

const deps = denoDeps();
Deno.serve((req) => route(req, deps));
