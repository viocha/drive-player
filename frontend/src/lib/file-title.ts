import { cn } from "./utils";

export function fileTitleClassName(lines: number) {
  return cn("whitespace-normal break-all", ["line-clamp-1", "line-clamp-2", "line-clamp-3"][lines - 1]);
}
