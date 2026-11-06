/** cast tables: characters, character_design_sheets, character_sheet_images (only this module touches them). */
import { and, asc, desc, eq } from "@ncs/db/orm";
import {
  characterDesignSheets,
  characters,
  characterSheetImages,
  type CharacterDesignSheetsInsert,
  type CharactersInsert,
  type CharacterSheetImagesInsert,
} from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Character, CharacterDesignSheet, CharacterSheetImage } from "../../index.js";

export const castRepo = {
  async list(db: Db, scope: NovelScope): Promise<Character[]> {
    return db.select().from(characters).where(eq(characters.novelId, scope.novelId)).orderBy(asc(characters.ord), asc(characters.createdAt), asc(characters.id));
  },
  async get(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Character | null> {
    const q = db.select().from(characters).where(and(eq(characters.novelId, scope.novelId), eq(characters.id, id)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  async insert(db: Db, row: CharactersInsert): Promise<Character> {
    const [r] = await db.insert(characters).values(row).returning();
    return r!;
  },
  async update(db: Db, scope: NovelScope, id: string, patch: Partial<CharactersInsert>): Promise<Character> {
    const [r] = await db
      .update(characters)
      .set(patch)
      .where(and(eq(characters.novelId, scope.novelId), eq(characters.id, id)))
      .returning();
    return r!;
  },
  async remove(db: Db, scope: NovelScope, id: string): Promise<void> {
    await db.delete(characters).where(and(eq(characters.novelId, scope.novelId), eq(characters.id, id)));
  },

  async getSheet(db: Db, scope: NovelScope, characterId: string, forUpdate = false): Promise<CharacterDesignSheet | null> {
    const q = db.select().from(characterDesignSheets).where(and(eq(characterDesignSheets.novelId, scope.novelId), eq(characterDesignSheets.characterId, characterId)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  async listSheets(db: Db, scope: NovelScope): Promise<CharacterDesignSheet[]> {
    return db.select().from(characterDesignSheets).where(eq(characterDesignSheets.novelId, scope.novelId));
  },
  async insertSheet(db: Db, row: CharacterDesignSheetsInsert): Promise<CharacterDesignSheet> {
    const [r] = await db.insert(characterDesignSheets).values(row).returning();
    return r!;
  },
  async updateSheet(db: Db, scope: NovelScope, id: string, patch: Partial<CharacterDesignSheetsInsert>): Promise<CharacterDesignSheet> {
    const [r] = await db
      .update(characterDesignSheets)
      .set(patch)
      .where(and(eq(characterDesignSheets.novelId, scope.novelId), eq(characterDesignSheets.id, id)))
      .returning();
    return r!;
  },

  async insertImage(db: Db, row: CharacterSheetImagesInsert): Promise<CharacterSheetImage> {
    const [r] = await db.insert(characterSheetImages).values(row).returning();
    return r!;
  },
  async listImages(db: Db, scope: NovelScope, characterId: string, limit = 60): Promise<CharacterSheetImage[]> {
    return db
      .select()
      .from(characterSheetImages)
      .where(and(eq(characterSheetImages.novelId, scope.novelId), eq(characterSheetImages.characterId, characterId)))
      .orderBy(desc(characterSheetImages.createdAt), desc(characterSheetImages.id))
      .limit(limit);
  },
};
