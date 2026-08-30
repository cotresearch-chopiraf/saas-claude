import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Dashboard } from "./pages/Dashboard";
import { Quotes } from "./pages/Quotes";
import { PublicQuote } from "./pages/PublicQuote";
import { Invoices } from "./pages/Invoices";
import { PublicInvoice } from "./pages/PublicInvoice";
import { Suppliers } from "./pages/Suppliers";
import { Customers } from "./pages/Customers";
import { CustomerDetail } from "./pages/CustomerDetail";
import { Team } from "./pages/Team";
import { Settings } from "./pages/Settings";
import { Compliance } from "./pages/Compliance";
import { ProjectWorkspace } from "./project/ProjectWorkspace";
import { OverviewSection } from "./project/sections/OverviewSection";
import { ContractSection } from "./project/sections/ContractSection";
import { BoqSection } from "./project/sections/BoqSection";
import { CostPlanSection } from "./project/sections/CostPlanSection";
import { ProcurementSection } from "./project/sections/ProcurementSection";
import { ActualCostSection } from "./project/sections/ActualCostSection";
import { ProgressSection } from "./project/sections/ProgressSection";
import { ForecastSection } from "./project/sections/ForecastSection";
import { CashFlowSection } from "./project/sections/CashFlowSection";
import { IpcSection } from "./project/sections/IpcSection";
import { SubcontractIpcSection } from "./project/sections/SubcontractIpcSection";
import { InvoicesSection } from "./project/sections/InvoicesSection";
import { DocumentsSection } from "./project/sections/DocumentsSection";
import { OperationsSection } from "./project/sections/OperationsSection";
import { LegacyBudgetSection } from "./project/sections/LegacyBudgetSection";
import { legacySection } from "./project/sections";

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/q/:token" element={<PublicQuote />} />
      <Route path="/i/:token" element={<PublicInvoice />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/projects/:id"
        element={
          <ProtectedRoute>
            <ProjectWorkspace />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewSection />} />
        <Route path="contract" element={<ContractSection />} />
        <Route path="boq" element={<BoqSection />} />
        <Route path="cost-plan" element={<CostPlanSection />} />
        <Route path="procurement" element={<ProcurementSection />} />
        <Route path="actual-cost" element={<ActualCostSection />} />
        <Route path="progress" element={<ProgressSection />} />
        <Route path="ipc" element={<IpcSection />} />
        <Route path="forecast" element={<ForecastSection />} />
        <Route path="cash-flow" element={<CashFlowSection />} />
        <Route path="invoices" element={<InvoicesSection />} />
        <Route path="operations" element={<OperationsSection />} />
        <Route path="documents" element={<DocumentsSection />} />
        {/* Contextual, not part of projectSections/the sidebar nav —
            entered only from an eligible active subcontract commitment in
            ProcurementSection, same as legacySection's own precedent for a
            workspace route outside the main nav list. */}
        <Route path="subcontract-ipcs/:commitmentId" element={<SubcontractIpcSection />} />
        <Route path={legacySection.path} element={<LegacyBudgetSection />} />
      </Route>
      <Route
        path="/quotes"
        element={
          <ProtectedRoute>
            <Quotes />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices"
        element={
          <ProtectedRoute>
            <Invoices />
          </ProtectedRoute>
        }
      />
      <Route
        path="/suppliers"
        element={
          <ProtectedRoute>
            <Suppliers />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers"
        element={
          <ProtectedRoute>
            <Customers />
          </ProtectedRoute>
        }
      />
      <Route
        path="/customers/:id"
        element={
          <ProtectedRoute>
            <CustomerDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/team"
        element={
          <ProtectedRoute>
            <Team />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />
      <Route
        path="/compliance"
        element={
          <ProtectedRoute>
            <Compliance />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
