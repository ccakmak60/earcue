import { toNodeHandler } from "better-auth/node";
import { auth } from "../_lib/auth-server.js";

export const config = { api: { bodyParser: false } };
export default toNodeHandler(auth);
