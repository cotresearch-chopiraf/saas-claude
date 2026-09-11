import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { PlatformAuthProvider } from "./platform/auth/PlatformAuthContext";
import { ClientPortalAuthProvider } from "./portal/auth/ClientPortalAuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n/I18nProvider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <AuthProvider>
          <PlatformAuthProvider>
            <ClientPortalAuthProvider>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </ClientPortalAuthProvider>
          </PlatformAuthProvider>
        </AuthProvider>
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
