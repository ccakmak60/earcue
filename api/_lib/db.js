import { neon } from "@neondatabase/serverless";
import { env } from "./env.js";

export const sql = neon(env.DATABASE_URL);
