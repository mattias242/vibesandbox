import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './client.ts';
import type { OpenTarget } from './api.ts';

/** Kortare än överlämningslänkens minut, så att ett klick aldrig möter en utgången länk. */
const LINK_REFRESH_MS = 45_000;

/**
 * En länk som öppnar förhandsvisningen eller den publicerade appen i en ny flik.
 *
 * Adressen från `open` loggar in webbläsaren på appens värd, är engångs och gäller en minut. Därför
 * hämtas en ny adress efter varje klick och innan den gamla hunnit gå ut. Det är en vanlig länk (inte `window.open` efter en väntan), så
 * att popup-spärrar inte stoppar den, och `noopener` hindrar appen i den nya fliken från att
 * styra byggverktygets flik.
 */
export function OpenLink({
  appId,
  target,
  version = 0,
  className,
  children,
}: {
  appId: string;
  target: OpenTarget;
  version?: number;
  className?: string;
  children: ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  const refresh = useCallback(() => setRound((value) => value + 1), []);

  // Länken gäller en minut (se identitetsleverantörens överlämning); byt den i god tid.
  useEffect(() => {
    const timer = window.setInterval(refresh, LINK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let current = true;
    setUrl(null);
    api.openUrl(appId, target).then(
      (value) => {
        if (current) setUrl(value);
      },
      () => {
        if (current) setUrl(null);
      },
    );
    return () => {
      current = false;
    };
  }, [appId, target, version, round]);

  if (url === null) {
    return (
      <button type="button" className={className} disabled>
        {children}
      </button>
    );
  }
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      onClick={() => window.setTimeout(refresh, 500)}
    >
      {children}
      <span className="visually-hidden"> (öppnas i en ny flik)</span>
    </a>
  );
}
