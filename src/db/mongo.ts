import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export async function connectMongo(): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  logger.info("MongoDB connected");
  return mongoose;
}

export function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}
