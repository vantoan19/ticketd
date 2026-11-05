import { isUrl } from "platejs";

/** Links to Documents, Plans and tickets use ticketd://; Plate rejects that scheme by default. */
export const linkPluginOptions = {
  allowedSchemes: ["http", "https", "mailto", "tel", "ticketd"],
  isUrl: (url: string) => /^ticketd:\/\/\S+$/i.test(url) || isUrl(url),
};
