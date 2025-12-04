import { MongoClient, Db } from 'mongodb';

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;

declare global {
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

/**
 * Get MongoDB URI from environment variables
 * Throws error only when actually needed (lazy evaluation)
 */
function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('Please add your Mongo URI to .env.local');
  }
  return uri;
}

/**
 * Get database name from environment variables
 * Throws error only when actually needed (lazy evaluation)
 */
function getDbName(): string {
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    throw new Error('Please add your DB_NAME to .env.local');
  }
  return dbName;
}

/**
 * Get or create MongoDB client promise
 * Lazy initialization - only creates client when needed
 */
function getClientPromise(): Promise<MongoClient> {
  if (clientPromise) {
    return clientPromise;
  }

  const uri = getMongoUri();

  if (process.env.NODE_ENV === 'development') {
    // In development mode, use a global variable so that the value
    // is preserved across module reloads caused by HMR (Hot Module Replacement).
    if (!global._mongoClientPromise) {
      client = new MongoClient(uri);
      global._mongoClientPromise = client.connect();
    }
    clientPromise = global._mongoClientPromise;
  } else {
    // In production mode, it's best to not use a global variable.
    client = new MongoClient(uri);
    clientPromise = client.connect();
  }

  return clientPromise;
}

/**
 * Get MongoDB database instance
 * @returns Promise<Db> - MongoDB database instance
 */
export async function getDatabase(): Promise<Db> {
  const clientInstance = await getClientPromise();
  const dbName = getDbName();
  return clientInstance.db(dbName);
}

/**
 * Get MongoDB client (for advanced operations)
 * @returns Promise<MongoClient> - MongoDB client instance
 */
export async function getClient(): Promise<MongoClient> {
  return getClientPromise();
}

// Export getClientPromise function for backward compatibility (lazy initialization)
// Note: Do not call it here to avoid build-time execution
export default getClientPromise;

