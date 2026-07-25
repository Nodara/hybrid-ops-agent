/**
 * Standalone seed helper. The app also seeds automatically on first boot
 * (DatabaseService.seedIfEmpty), so this is only needed if you want to seed
 * a fresh database out-of-band: `npm run seed`.
 */
import { DatabaseService } from './database.service';

const svc = new DatabaseService();
svc.onModuleInit();
// eslint-disable-next-line no-console
console.log('Seed complete.');
svc.onModuleDestroy();
