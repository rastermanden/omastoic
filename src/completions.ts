import { parseAuthors } from "./canvas.ts";

export const AUTHORS_PLACEHOLDER = "@AUTHORS@";

/** Word list for `--authors`: `all` then every slug in `authors.tsv` order. */
export function authorCompletionList(tsv: string): string {
  return ["all", ...parseAuthors(tsv).keys()].join(" ");
}

export function renderCompletion(template: string, authors: string): string {
  return template.replaceAll(AUTHORS_PLACEHOLDER, authors);
}
