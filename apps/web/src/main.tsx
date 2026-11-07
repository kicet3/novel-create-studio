import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { QueryProvider } from "./api/query-client.js";
import { router } from "./app/router.js";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./app/theme.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryProvider>
      <RouterProvider router={router} />
    </QueryProvider>
  </StrictMode>,
);
