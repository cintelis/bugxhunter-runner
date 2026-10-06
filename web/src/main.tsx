import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthGate, UNAUTHORIZED_EVENT } from "./Login";
import "./styles.css";

// Any API call that finds the session expired sends the user back to the login screen.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (res.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return res;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
