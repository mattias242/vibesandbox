import { useEffect, useState } from 'react';
import { ADMIN_TOKEN_WINDOW_DAYS, type AdminApp, type AdminOverview } from '@vibesandbox/contracts';
import {
  ADMIN_APPS_HEADING,
  ADMIN_EMPTY,
  ADMIN_FIGURES_HEADING,
  ADMIN_ID_NOTE,
  ADMIN_LEAD,
  ADMIN_LOADING,
  ADMIN_OWNER_MISSING,
  ADMIN_TITLE,
  ADMIN_TOKENS_NOTE,
  ADMIN_USERS_UNKNOWN,
  adminErrorMessage,
  statusOf,
} from './admin.ts';
import { api } from './client.ts';
import { formatCount, formatUpdated } from './format.ts';

/**
 * Kontrollrummet: plattformens administratör ser alla appar utan att gå in på servern.
 *
 * Vyn är ren läsning — här finns inte en enda knapp som ändrar något, och inte en enda länk in i
 * någon annans app. Appens fulla id är dess hemliga adress; listan visar bara början av den, och
 * gör aldrig en länk av den.
 *
 * Hämtningen och utseendet ligger isär: `AdminPage` hämtar, `AdminView` visar. Då går vyns alla
 * lägen — laddar, tom, full lista, nekad — att pröva utan webbläsare.
 */
export function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [apps, setApps] = useState<readonly AdminApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Båda anropen tillsammans: vyn visar ingenting förrän den har hela bilden, och ett nekat
    // anrop ska ge ett besked — inte en halv sida.
    Promise.all([api.adminOverview(), api.adminApps()]).then(
      ([nextOverview, nextApps]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setApps(nextApps);
      },
      (caught: unknown) => {
        if (!cancelled) setError(adminErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return <AdminView overview={overview} apps={apps} error={error} />;
}

export interface AdminViewProps {
  readonly overview: AdminOverview | null;
  readonly apps: readonly AdminApp[] | null;
  readonly error: string | null;
}

export function AdminView({ overview, apps, error }: AdminViewProps) {
  return (
    <div className="page page-admin">
      <h1>{ADMIN_TITLE}</h1>
      <p className="hint">{ADMIN_LEAD}</p>

      {error !== null ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : overview === null || apps === null ? (
        <p className="muted" aria-live="polite">
          {ADMIN_LOADING}
        </p>
      ) : (
        <>
          <section className="admin-block" aria-labelledby="admin-figures-heading">
            <h2 id="admin-figures-heading">{ADMIN_FIGURES_HEADING}</h2>
            <dl className="admin-figures">
              <Figure label="Appar" value={overview.apps} />
              <Figure label="Publicerade" value={overview.published} />
              <Figure label="Väntar på att publiceras" value={overview.drafts} />
              <Figure label={`Bygg senaste ${ADMIN_TOKEN_WINDOW_DAYS} dygnen`} value={overview.tokens.jobs} />
              <Figure label="Bygg som gick fel" value={overview.failedJobs} />
              <Figure label="Tokens in" value={overview.tokens.input} />
              <Figure label="Tokens ut" value={overview.tokens.output} />
            </dl>
            <p className="hint">{ADMIN_TOKENS_NOTE}</p>
            <p className="hint">{ADMIN_USERS_UNKNOWN}</p>
          </section>

          <section className="admin-block" aria-labelledby="admin-apps-heading">
            <h2 id="admin-apps-heading">{ADMIN_APPS_HEADING}</h2>
            <p className="hint">{ADMIN_ID_NOTE}</p>
            {apps.length === 0 ? <p className="muted">{ADMIN_EMPTY}</p> : <AppTable apps={apps} />}
          </section>
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-figure">
      <dt>{label}</dt>
      <dd>{formatCount(value)}</dd>
    </div>
  );
}

/**
 * Riktiga tabellelement, inte rutor som ser ut som en tabell: appens namn är radens rubrik
 * (`th scope="row"`), så att en skärmläsare kan säga vilken app en cell hör till.
 */
function AppTable({ apps }: { apps: readonly AdminApp[] }) {
  return (
    // På smal skärm rullar tabellen i sidled i stället för att kolumnerna knycklas ihop.
    // tabIndex + role gör att den som bara har tangentbord kan rulla den, och att den får ett namn.
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_APPS_HEADING} tabIndex={0}>
      <table className="admin-table">
        <caption className="visually-hidden">Alla appar i plattformen, den som ändrats senast först</caption>
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Ägare</th>
            <th scope="col">Läge</th>
            <th scope="col" className="admin-num">
              Personer
            </th>
            <th scope="col" className="admin-num">
              Tokens in / ut
            </th>
            <th scope="col">Senast ändrad</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app, index) => {
            const status = statusOf(app);
            return (
              <tr key={`${app.appIdPrefix}-${index}`}>
                <th scope="row" className="admin-app">
                  <span className="admin-app-name">{app.name}</span>
                  {/* Bara början av adressen — och som text, aldrig som länk. */}
                  <span className="admin-prefix">Börjar med {app.appIdPrefix}</span>
                </th>
                <td>{app.ownerEmail ?? <span className="muted">{ADMIN_OWNER_MISSING}</span>}</td>
                <td>
                  <span className={status.published ? 'badge badge-published' : 'badge'}>{status.label}</span>
                  {status.note !== null && <span className="admin-note">{status.note}</span>}
                </td>
                <td className="admin-num">{formatCount(app.members)}</td>
                <td className="admin-num">
                  {formatCount(app.tokens.input)} / {formatCount(app.tokens.output)}
                </td>
                <td>{formatUpdated(app.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
