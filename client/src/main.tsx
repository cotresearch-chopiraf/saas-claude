import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { PlatformAuthProvider } from "./platform/auth/PlatformAuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PlatformAuthProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </PlatformAuthProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
