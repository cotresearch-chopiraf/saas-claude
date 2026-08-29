import { Layout } from "../components/Layout";
import { ComingSoon } from "../ui/ComingSoon";

// Global nav placeholder only — the Supplier domain UI itself is UI-02
// scope. The backend (/api/suppliers) already exists and is fully
// functional; only the screen is missing.
export function Suppliers() {
  return (
    <Layout>
      <ComingSoon title="الموردون" description="سيتيح هذا القسم إدارة دليل الموردين والمقاولين من الباطن في مرحلة قادمة." />
    </Layout>
  );
}
