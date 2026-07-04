import { openDb } from './src/db.js';
import { ingestBazaar } from './src/bazaar.js';

const db = openDb(':memory:');
const result = await ingestBazaar(db);
const stats = db.prepare('SELECT COUNT(*) t, COUNT(price_usdc) with_price, COUNT(name) with_name FROM services').get();
console.log('Upserted:', result.upserted);
console.log('Stats:', stats);
