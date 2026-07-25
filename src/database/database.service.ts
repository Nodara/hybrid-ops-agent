import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

/**
 * Owns the SQLite connection and schema. Kept intentionally thin so the same
 * SQL-shaped repository layer could be pointed at Postgres later (the data model
 * in the brief is Postgres-or-SQLite).
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  public db!: Database.Database;

  onModuleInit(): void {
    const dbPath = process.env.DATABASE_PATH || "./data/useradmin.db";
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.createSchema();
    this.cleanUpAllTables();
    this.seedIfEmpty();
    this.logger.log(`SQLite ready at ${dbPath}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  /**
   * Removes all rows from every table. Deletes audit_log first to respect the
   * foreign key into users. Wrapped in a transaction so it is all-or-nothing.
   */
  cleanUpAllTables(): void {
    const wipe = this.db.transaction(() => {
      this.db.exec("DELETE FROM audit_log;");
      this.db.exec("DELETE FROM users;");
      this.db.exec(
        "DELETE FROM sqlite_sequence WHERE name IN ('users','audit_log');",
      );
    });
    wipe();
    this.logger.log("Cleaned up all tables");
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        actor          TEXT NOT NULL,
        action         TEXT NOT NULL,
        target_user_id INTEGER,
        timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
        details        TEXT,
        FOREIGN KEY (target_user_id) REFERENCES users(id)
      );
    `);
  }

  private static readonly SEED_COUNT = 2500;

  private static readonly FIRST_NAMES = [
    "Ada",
    "Alan",
    "Grace",
    "Katherine",
    "Linus",
    "Margaret",
    "Dennis",
    "Barbara",
    "Edsger",
    "Donald",
    "Tim",
    "Ken",
    "John",
    "Claude",
    "Guido",
    "Bjarne",
    "James",
    "Anita",
    "Radia",
    "Hedy",
  ];

  private static readonly LAST_NAMES = [
    "Lovelace",
    "Turing",
    "Hopper",
    "Johnson",
    "Torvalds",
    "Hamilton",
    "Ritchie",
    "Liskov",
    "Dijkstra",
    "Knuth",
    "Berners-Lee",
    "Thompson",
    "McCarthy",
    "Shannon",
    "van Rossum",
    "Stroustrup",
    "Gosling",
    "Borg",
    "Perlman",
    "Lamarr",
  ];

  /** Email domains seeded users are spread across, chosen at random per user. */
  private static readonly DOMAINS = [
    "example.com",
    "acme.com",
    "globex.com",
    "initech.io",
    "umbrella.co",
    "hooli.com",
    "wayne-enterprises.com",
  ];

  private static readonly ROLES = ["admin", "editor", "viewer"] as const;
  private static readonly STATUSES = [
    "active",
    "suspended",
    "deleted",
  ] as const;

  private seedIfEmpty(): void {
    const { count } = this.db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as {
      count: number;
    };
    if (count > 0) return;

    const insert = this.db.prepare(
      "INSERT INTO users (email, name, role, status) VALUES (@email, @name, @role, @status)",
    );
    const seed = this.db.transaction((rows: Record<string, string>[]) => {
      for (const row of rows) insert.run(row);
    });

    seed(this.generateUsers(DatabaseService.SEED_COUNT));

    this.logger.log(`Seeded ${DatabaseService.SEED_COUNT} demo users`);
  }

  /**
   * Builds a set of demo users. Names cycle through the first/last name pools
   * and the email is suffixed with the index to keep the UNIQUE(email)
   * constraint satisfied. Each user is assigned a random domain from DOMAINS so
   * the data spans several organisations (useful for the suspend-by-domain
   * flow). Most users are active; roughly every 10th is suspended and every
   * 25th is deleted so the data has some variety.
   */
  private generateUsers(count: number): Record<string, string>[] {
    const { FIRST_NAMES, LAST_NAMES, ROLES, DOMAINS } = DatabaseService;
    const users: Record<string, string>[] = [];

    for (let i = 0; i < count; i++) {
      const first = FIRST_NAMES[i % FIRST_NAMES.length];
      const last =
        LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
      const role = ROLES[i % ROLES.length];
      const status =
        i % 25 === 0 ? "deleted" : i % 10 === 0 ? "suspended" : "active";
      const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];

      users.push({
        email: `${first}.${last}.${i + 1}@${domain}`.toLowerCase(),
        name: `${first} ${last}`,
        role,
        status,
      });
    }

    return users;
  }
}
