import { createRoot } from "react-dom/client";
import Landing from "./Landing";
import "./screens/app.css";
import "./landing.css";

const root = document.getElementById("root");
if (!root) throw new Error("The docs page is missing its root element.");
createRoot(root).render(<Landing />);
