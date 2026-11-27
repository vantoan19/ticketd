import { createContext } from "react";
import type { ReferenceReplacement } from "./AttachmentPreview";

/** One file of the place a link or card sits in, in reading order. */
export type PlaceFile = {
  uri: string;
  replace: ReferenceReplacement | undefined;
};

/**
 * The files of the text a link sits in (an update, a description, a Document):
 * what Previous and Next walk when one of them is opened. Read when the viewer
 * opens, so the text is free to change until then.
 */
export const AttachmentPlace = createContext<(() => PlaceFile[]) | null>(null);
