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
      // Child-before-parent order: refunds/ticket_messages reference
      // subscriptions/tickets, which reference users.
      this.db.exec("DELETE FROM refunds;");
      this.db.exec("DELETE FROM ticket_messages;");
      this.db.exec("DELETE FROM subscriptions;");
      this.db.exec("DELETE FROM tickets;");
      this.db.exec("DELETE FROM kb_articles;");
      this.db.exec("DELETE FROM audit_log;");
      this.db.exec("DELETE FROM transactions;");
      this.db.exec("DELETE FROM users;");
      this.db.exec(
        "DELETE FROM sqlite_sequence WHERE name IN " +
          "('users','audit_log','transactions','subscriptions','tickets','ticket_messages','refunds','kb_articles');",
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
        role       TEXT NOT NULL CHECK (role IN ('admin','editor','viewer','customer')),
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
        country    TEXT,
        city       TEXT,
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

      -- Shared ledger: every financial event on a user, regardless of which
      -- product wrote it (Product 2's refunds/billing, Product 3 reads from it).
      CREATE TABLE IF NOT EXISTS transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        type         TEXT NOT NULL CHECK (type IN ('subscription_charge','refund','balance_credit','balance_debit')),
        amount_cents INTEGER NOT NULL,
        currency     TEXT NOT NULL DEFAULT 'usd',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        metadata     TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      -- Product 2 (SupportDesk) tables. A ticket's user IS a users row with
      -- role='customer' — no separate customers table.
      CREATE TABLE IF NOT EXISTS subscriptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        plan       TEXT NOT NULL CHECK (plan IN ('starter','pro','enterprise')),
        mrr_cents  INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled','past_due')),
        renewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        subject    TEXT NOT NULL,
        body       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','escalated')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  INTEGER NOT NULL,
        sender     TEXT NOT NULL CHECK (sender IN ('customer','agent','human')),
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      -- Refunds also write a mirrored row into transactions (type='refund',
      -- metadata.refund_id) so Product 3 can see them without joining
      -- through Product 2's schema.
      CREATE TABLE IF NOT EXISTS refunds (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        amount_cents    INTEGER NOT NULL,
        reason          TEXT NOT NULL,
        issued_by       TEXT NOT NULL,
        approved_by     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
      );

      CREATE TABLE IF NOT EXISTS kb_articles (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        title    TEXT NOT NULL,
        body     TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT ''
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

  private static readonly ROLES = [
    "admin",
    "editor",
    "viewer",
    "customer",
  ] as const;

  /** Country -> a plausible city, kept as pairs so city always matches its country. */
  private static readonly LOCATIONS: [string, string][] = [
    ["United States", "New York"],
    ["United States", "San Francisco"],
    ["United Kingdom", "London"],
    ["Germany", "Berlin"],
    ["France", "Paris"],
    ["Japan", "Tokyo"],
    ["Australia", "Sydney"],
    ["Canada", "Toronto"],
    ["Brazil", "Sao Paulo"],
    ["India", "Bangalore"],
  ];

  private static readonly TRANSACTION_TYPES = [
    "subscription_charge",
    "refund",
    "balance_credit",
    "balance_debit",
  ] as const;

  private static readonly PLANS = ["starter", "pro", "enterprise"] as const;

  private static readonly PLAN_MRR_CENTS: Record<string, number> = {
    starter: 1900,
    pro: 4900,
    enterprise: 19900,
  };

  private static readonly TICKET_SUBJECTS = [
    "Refund request",
    "Cannot access my account",
    "Question about my invoice",
    "How do I export my data?",
    "Billed twice this month",
    "Downgrade my plan",
  ];

  private static readonly REFUND_REASONS = [
    "Accidental duplicate charge",
    "Customer dissatisfaction",
    "Service outage credit",
    "Downgrade proration",
  ];

  private static readonly KB_ARTICLES: { title: string; body: string; keywords: string }[] = [
    {
      title: "Billing & Refund Policy",
      body:
        "We auto-approve refunds up to $50 with no additional approval. Refunds between " +
        "$50 and $200 require manager approval. We do not issue refunds above $200 through " +
        "automated channels — these are handled by a human billing specialist. Refunds are " +
        "also capped at the unused, remaining portion of your current billing period.",
      keywords: "refund,billing,policy,charge,approval",
    },
    {
      title: "Subscription Management",
      body:
        "You can upgrade, downgrade, or cancel your subscription at any time from Account > " +
        "Billing. Downgrades take effect at the next renewal date; upgrades are prorated " +
        "immediately.",
      keywords: "subscription,plan,upgrade,downgrade,cancel",
    },
    {
      title: "Account & Login Issues",
      body:
        "If you cannot log in, first check for a password-reset email in your spam folder. " +
        "Accounts are locked after 5 failed attempts for 15 minutes. If your account shows " +
        "as suspended, contact support — a support agent cannot lift a suspension themselves.",
      keywords: "login,password,locked,suspended,account access",
    },
    {
      title: "Exporting Your Data",
      body:
        "You can export a full copy of your account data (profile, billing history, usage " +
        "logs) as a CSV from Account > Data Export. Exports are generated within 24 hours " +
        "and emailed as a download link valid for 7 days.",
      keywords: "export,data,csv,download,gdpr",
    },
    {
      title: "Disputes & Legal Requests",
      body:
        "Any ticket referencing legal action, regulatory complaints, subpoenas, or security " +
        "incidents is automatically routed to a human specialist and cannot be resolved by " +
        "an automated agent, regardless of the amount involved.",
      keywords: "legal,dispute,security,subpoena,gdpr,breach",
    },
  ];

  /** Repetitive back-and-forth used to pad the seeded compaction-demo thread to 30 messages. */
  private static readonly COMPACTION_DEMO_MESSAGES = [
    "I was charged twice this month, can you check my account?",
    "Thanks for flagging this — pulling up your billing history now.",
    "I see two charges on the same day, that doesn't look right.",
    "You're right, I see the duplicate too. Let me check with billing.",
    "Any update? It's been a few days.",
    "Still looking into it — this looks like a known issue with our payment processor's retry logic.",
    "Okay, please let me know when it's resolved.",
    "Our billing team confirmed it's a duplicate charge and it will be reversed.",
    "Great, thank you. When should I expect the reversal?",
    "Reversals typically post within 3-5 business days.",
  ];

  private seedIfEmpty(): void {
    const { count } = this.db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as {
      count: number;
    };
    if (count > 0) return;

    const insertUser = this.db.prepare(
      "INSERT INTO users (email, name, role, status, country, city) VALUES (@email, @name, @role, @status, @country, @city)",
    );
    const insertTransaction = this.db.prepare(
      "INSERT INTO transactions (user_id, type, amount_cents, currency, metadata) VALUES (?, ?, ?, 'usd', ?)",
    );
    const insertSubscription = this.db.prepare(
      "INSERT INTO subscriptions (user_id, plan, mrr_cents, status, renewed_at) " +
        "VALUES (?, ?, ?, ?, datetime('now', '-' || ? || ' days'))",
    );
    const insertTicket = this.db.prepare(
      "INSERT INTO tickets (user_id, subject, body, status) VALUES (?, ?, ?, ?)",
    );
    const insertTicketMessage = this.db.prepare(
      "INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)",
    );
    const insertRefund = this.db.prepare(
      "INSERT INTO refunds (subscription_id, amount_cents, reason, issued_by, approved_by) VALUES (?, ?, ?, ?, ?)",
    );
    const insertKbArticle = this.db.prepare(
      "INSERT INTO kb_articles (title, body, keywords) VALUES (?, ?, ?)",
    );

    const seed = this.db.transaction((rows: Record<string, string>[]) => {
      for (const row of rows) {
        const info = insertUser.run(row);
        // Give customer accounts a small transaction history so the shared
        // ledger has data to query (Product 2/3 territory, but Product 1
        // seeds it since it owns the identity table).
        if (row.role === "customer") {
          const userId = Number(info.lastInsertRowid);
          // Customer ids are always multiples of 4 (role cycles every 4
          // users), so id % 4 would always be 0 — divide down first to get
          // a value that actually varies per customer.
          const txCount = Math.floor(userId / 4) % 4; // 0-3 transactions
          for (let t = 0; t < txCount; t++) {
            const type = DatabaseService.TRANSACTION_TYPES[t % 4];
            const amount = type === "subscription_charge" ? 2900 : 500 * (t + 1);
            insertTransaction.run(
              userId,
              type,
              amount,
              JSON.stringify({ plan: "pro" }),
            );
          }

          // Product 2 (SupportDesk) data — one subscription per customer.
          const customerNumber = userId / 4; // 1, 2, 3, ... (always integral)
          const plan =
            DatabaseService.PLANS[customerNumber % DatabaseService.PLANS.length];
          const mrrCents = DatabaseService.PLAN_MRR_CENTS[plan];
          const renewedAtDaysAgo = customerNumber % 30;
          const subInfo = insertSubscription.run(
            userId,
            plan,
            mrrCents,
            "active",
            renewedAtDaysAgo,
          );
          const subscriptionId = Number(subInfo.lastInsertRowid);

          // Roughly 1-in-5 customers has an open ticket.
          if (customerNumber % 5 === 0) {
            const subject =
              DatabaseService.TICKET_SUBJECTS[
                customerNumber % DatabaseService.TICKET_SUBJECTS.length
              ];
            const body = `${subject} — can someone help me with this?`;
            const ticketInfo = insertTicket.run(userId, subject, body, "open");
            const ticketId = Number(ticketInfo.lastInsertRowid);
            insertTicketMessage.run(ticketId, "customer", body);
            if (customerNumber % 10 === 0) {
              insertTicketMessage.run(
                ticketId,
                "agent",
                "Thanks for reaching out — looking into this now.",
              );
            }
          }

          // Roughly 1-in-20 customers has a pre-existing refund, mirrored
          // into transactions exactly like RefundsService.issueRefund does
          // at runtime.
          if (customerNumber % 20 === 0) {
            const reason =
              DatabaseService.REFUND_REASONS[
                customerNumber % DatabaseService.REFUND_REASONS.length
              ];
            const amountCents = 500 * ((customerNumber % 10) + 1);
            const refundInfo = insertRefund.run(
              subscriptionId,
              amountCents,
              reason,
              "ops-console",
              "ops-console",
            );
            const refundId = Number(refundInfo.lastInsertRowid);
            insertTransaction.run(
              userId,
              "refund",
              amountCents,
              JSON.stringify({ refund_id: refundId }),
            );
          }
        }
      }

      // Static knowledge-base content, seeded unconditionally (not tied to
      // any customer).
      for (const article of DatabaseService.KB_ARTICLES) {
        insertKbArticle.run(article.title, article.body, article.keywords);
      }

      // Deterministic demo fixtures (not part of the random 2500) for the
      // paired refund-policy comparison and the compaction-mechanism check.
      // See CLAUDE.md / PRODUCT_SPECS.md Product 2 section.
      const demoDollarPolicy = insertUser.run({
        email: "demo.dollarpolicy@example.com",
        name: "Dana DollarPolicy",
        role: "customer",
        status: "active",
        country: "United States",
        city: "New York",
      });
      const demoDollarPolicyUserId = Number(demoDollarPolicy.lastInsertRowid);
      insertSubscription.run(demoDollarPolicyUserId, "enterprise", 19900, "active", 0);
      const dollarPolicyTicket = insertTicket.run(
        demoDollarPolicyUserId,
        "Refund request",
        "Can you refund me $120 for last month? I wasn't happy with the service.",
        "open",
      );
      insertTicketMessage.run(
        Number(dollarPolicyTicket.lastInsertRowid),
        "customer",
        "Can you refund me $120 for last month? I wasn't happy with the service.",
      );

      const demoKeywordFilter = insertUser.run({
        email: "demo.keywordfilter@example.com",
        name: "Kevin KeywordFilter",
        role: "customer",
        status: "active",
        country: "United States",
        city: "San Francisco",
      });
      const demoKeywordFilterUserId = Number(demoKeywordFilter.lastInsertRowid);
      insertSubscription.run(demoKeywordFilterUserId, "pro", 4900, "active", 0);
      const keywordFilterTicket = insertTicket.run(
        demoKeywordFilterUserId,
        "Refund request",
        "Refund my $500 or I'll escalate this to legal.",
        "open",
      );
      insertTicketMessage.run(
        Number(keywordFilterTicket.lastInsertRowid),
        "customer",
        "Refund my $500 or I'll escalate this to legal.",
      );

      const demoCompaction = insertUser.run({
        email: "demo.compaction@example.com",
        name: "Cara Compaction",
        role: "customer",
        status: "active",
        country: "United States",
        city: "Austin",
      });
      const demoCompactionUserId = Number(demoCompaction.lastInsertRowid);
      insertSubscription.run(demoCompactionUserId, "starter", 1900, "active", 0);
      const compactionTicket = insertTicket.run(
        demoCompactionUserId,
        "Ongoing billing dispute",
        "I've been charged incorrectly multiple times and need this resolved.",
        "open",
      );
      const compactionTicketId = Number(compactionTicket.lastInsertRowid);
      for (let m = 0; m < 30; m++) {
        const sender = m % 2 === 0 ? "customer" : "agent";
        const body =
          DatabaseService.COMPACTION_DEMO_MESSAGES[
            m % DatabaseService.COMPACTION_DEMO_MESSAGES.length
          ];
        insertTicketMessage.run(compactionTicketId, sender, body);
      }
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
    const { FIRST_NAMES, LAST_NAMES, ROLES, DOMAINS, LOCATIONS } =
      DatabaseService;
    const users: Record<string, string>[] = [];

    for (let i = 0; i < count; i++) {
      const first = FIRST_NAMES[i % FIRST_NAMES.length];
      const last =
        LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
      const role = ROLES[i % ROLES.length];
      const status =
        i % 25 === 0 ? "deleted" : i % 10 === 0 ? "suspended" : "active";
      const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
      const [country, city] =
        LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];

      users.push({
        email: `${first}.${last}.${i + 1}@${domain}`.toLowerCase(),
        name: `${first} ${last}`,
        role,
        status,
        country,
        city,
      });
    }

    return users;
  }
}
