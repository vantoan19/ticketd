import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEqual,
  CircleSlash,
  type LucideIcon,
} from "lucide-react";

/** The glyph of a status; Canceled and Duplicate never share Done’s. */
export const statusIcons: Record<string, LucideIcon> = {
  Todo: Circle,
  "In progress": CircleDot,
  "In review": CircleDashed,
  Done: CircleCheck,
  Canceled: CircleSlash,
  Duplicate: CircleEqual,
};
