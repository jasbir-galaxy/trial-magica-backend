import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const globalForDatabase = globalThis as typeof globalThis & {
  database?: PrismaClient;
};

// Create the pool on first use and reuse it across development hot reloads.
export function getDatabase(): PrismaClient {
  if (globalForDatabase.database) return globalForDatabase.database;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for database access.");

  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: 5000,
    max: 5,
  });
  globalForDatabase.database = new PrismaClient({ adapter });
  return globalForDatabase.database;
}
