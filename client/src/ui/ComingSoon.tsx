import { PageHeader } from "./PageHeader";
import { useTranslation } from "../i18n/I18nProvider";

// The one placeholder used for every not-yet-built MIDAD section — never
// fake data, never a fabricated metric, only an honest "not yet" message.
// See UI-Foundation scope: this component exists specifically so no future
// page reinvents its own "coming soon" copy or, worse, ships fake numbers
// to fill the space.
export function ComingSoon({ title, description }: { title: string; description?: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={title} />
      <div className="rounded-lg border border-dashed border-stone-300 p-10 text-center text-stone-500">
        <p className="font-medium text-stone-600">{t("common.comingSoon")}</p>
        {description && <p className="mt-2 text-sm">{description}</p>}
      </div>
    </div>
  );
}
