import { handle } from "./router.ts";
import { makeDb } from "../_shared/db.ts";

Deno.serve((req) => handle(req, makeDb()));
