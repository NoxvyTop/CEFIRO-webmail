import { useTranslation } from "react-i18next";

export function AdminPage() {
  const { t } = useTranslation();
  return <main aria-label={t("admin.title")}>{t("admin.title")}</main>;
}
