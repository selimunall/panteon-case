import { MongoClient, type Db as MongoDb } from 'mongodb';

export async function createMongo(url: string, dbName: string): Promise<{ client: MongoClient; db: MongoDb }> {
  const client = new MongoClient(url);
  await client.connect();
  return { client, db: client.db(dbName) };
}
