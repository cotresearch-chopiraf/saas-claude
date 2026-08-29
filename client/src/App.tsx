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
import { Team } from "./pages/Team";
import { Settings } from "./pages/Settings";
import { ProjectWorkspace } from "./project/ProjectWorkspace";
import { OverviewSection } from "./project/sections/OverviewSection";
import { ContractSection } from "./project/sections/ContractSection";
import { BoqSection } from "./project/sections/BoqSection";
import { CostPlanSection } from "./project/sections/CostPlanSection";
import { ProcurementSection } from "./project/sections/ProcurementSection";
import { OperationsSection } from "./project/sections/OperationsSection";
import { LegacyBudgetSection } from "./project/sections/LegacyBudgetSection";
import { PlaceholderSection } from "./project/sections/PlaceholderSection";
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
        <Route path="actual-cost" element={<PlaceholderSection title="التكلفة الفعلية" description="المصروفات الفعلية المرتبطة بالمشروع." />} />
        <Route path="progress" element={<PlaceholderSection title="القياسات" description="قياسات التقدّم الفعلي مقابل جدول الكميات." />} />
        <Route path="ipc" element={<PlaceholderSection title="شهادات الدفع (IPC)" description="دورة اعتماد وتصديق شهادات الدفع المرحلية." />} />
        <Route path="forecast" element={<PlaceholderSection title="التوقعات المالية" description="التكلفة المتوقعة عند الإنجاز (EAC) والمتبقي لإنجاز العمل (ETC)." />} />
        <Route path="cash-flow" element={<PlaceholderSection title="التدفق النقدي" description="التدفق النقدي التاريخي والمتوقع لهذا المشروع." />} />
        <Route path="invoices" element={<PlaceholderSection title="الفواتير" description="فواتير هذا المشروع تحديداً." />} />
        <Route path="operations" element={<OperationsSection />} />
        <Route path="documents" element={<PlaceholderSection title="المستندات" description="مرفقات وأدلة المشروع." />} />
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
    </Routes>
  );
}
