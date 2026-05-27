import { useState, useEffect } from "react";
import { t, getLocale, setLocale } from "../lib/i18n";

/** Re-renders the component when locale changes. */
export function useTranslation() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTick((n) => n + 1);
    window.addEventListener("localechange", handler);
    return () => window.removeEventListener("localechange", handler);
  }, []);

  return { t, locale: getLocale(), setLocale };
}
