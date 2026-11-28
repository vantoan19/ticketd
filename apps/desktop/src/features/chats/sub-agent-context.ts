import { createContext } from "react";
import type { SubAgent } from "@/features/chats/client";

/** The Chat's sub-agents, for the rows that name them. */
export const SubAgentsContext = createContext<readonly SubAgent[]>([]);

/** True inside a sub-agent's view: its failure marker says "This sub-agent failed". */
export const InSubAgent = createContext(false);
