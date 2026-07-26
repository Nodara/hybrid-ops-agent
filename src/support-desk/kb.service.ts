import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { KbArticle } from "./support-desk.types";

@Injectable()
export class KbService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  search(query: string): KbArticle[] {
    const q = (query ?? "").trim();
    if (!q) {
      return this.db.prepare("SELECT * FROM kb_articles ORDER BY id LIMIT 10").all() as KbArticle[];
    }
    return this.db
      .prepare(
        "SELECT * FROM kb_articles WHERE title LIKE ? OR body LIKE ? OR keywords LIKE ? " +
          "ORDER BY id LIMIT 10",
      )
      .all(`%${q}%`, `%${q}%`, `%${q}%`) as KbArticle[];
  }
}
