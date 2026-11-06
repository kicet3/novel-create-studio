import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand a leading `~` and make the path absolute. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}
