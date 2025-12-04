import { MongoClient, Db } from 'mongodb';

if (!process.env.MONGODB_URI) {
  throw new Error('Please add your Mongo URI to .env.local');
}

if (!process.env.DB_NAME) {
  throw new Error('Please add your DB_NAME to .env.local');
}

const uri: string = process.env.MONGODB_URI;
const dbName: string = process.env.DB_NAME;

let client: MongoClient | null = null;
let clientPromise: Promise<MongoClient> | null = null;

declare global {
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

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

/**
 * Get MongoDB database instance
 * @returns Promise<Db> - MongoDB database instance
 */
export async function getDatabase(): Promise<Db> {
  if (!clientPromise) {
    client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  const clientInstance = await clientPromise;
  return clientInstance.db(dbName);
}

/**
 * Get MongoDB client (for advanced operations)
 * @returns Promise<MongoClient> - MongoDB client instance
 */
export async function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  return clientPromise;
}

export default clientPromise;

