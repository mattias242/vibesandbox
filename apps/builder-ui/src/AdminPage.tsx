import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ADMIN_TOKEN_WINDOW_DAYS,
  type AdminApp,
  type AdminOverview,
  type AdminStop,
  type AdminUser,
  type Role,
} from '@vibesandbox/contracts';
import {
  ADMIN_APPS_HEADING,
  ADMIN_DATE_UNKNOWN,
  ADMIN_EMPTY,
  ADMIN_FIGURES_HEADING,
  ADMIN_ID_NOTE,
  ADMIN_INVITE_BUTTON,
  ADMIN_INVITE_EMAIL_LABEL,
  ADMIN_INVITE_HEADING,
  ADMIN_INVITE_NOTE,
  ADMIN_INVITE_ROLE_LABEL,
  ADMIN_INVITE_SENDING,
  ADMIN_LEAD,
  ADMIN_LOADING,
  ADMIN_OWNER_MISSING,
  ADMIN_ROLE_BUTTON,
  ADMIN_ROLE_SAVING,
  ADMIN_ROLE_SELECT_LABEL,
  ADMIN_SELF_NOTE,
  ADMIN_STOPS_EMPTY,
  ADMIN_STOPS_HEADING,
  ADMIN_STOPS_PATTERN_NOTE,
  ADMIN_STOPS_PRIVACY_NOTE,
  ADMIN_TITLE,
  ADMIN_TOKENS_NOTE,
  ADMIN_USERS_COLUMNS,
  ADMIN_USERS_HEADING,
  ADMIN_USERS_LEAD,
  REDLINE_TEXTS,
  ROLES,
  ROLE_TEXTS,
  adminErrorMessage,
  countRoles,
  countStops,
  inviteErrorMessage,
  invitedMessage,
  roleChangedMessage,
  roleErrorMessage,
  roleLabel,
  statusOf,
  validateInviteEmail,
  withUser,
} from './admin.ts';
import { api } from './client.ts';
import { formatCount, formatUpdated } from './format.ts';

/**
 * Kontrollrummet: plattformens administratör ser alla appar utan att gå in på servern, och
 * bestämmer vilka adresser som får logga in.
 *
 * Applistan är ren läsning — där finns inte en enda knapp, och inte en enda länk in i någon annans
 * app. Appens fulla id är dess hemliga adress; listan visar bara början av den, och gör aldrig en
 * länk av den.
 *
 * Adresslistan ändrar. Den ändrar först när servern har svarat: knapparna skickar, och det är
 * SERVERNS rad som läggs in i listan. Ett misslyckat anrop lämnar därför vyn precis som den var,
 * med ett besked om varför.
 *
 * Hämtningen och utseendet ligger isär: `AdminPage` hämtar, `AdminView` visar. Då går vyns alla
 * lägen — laddar, tom, full lista, nekad — att pröva utan webbläsare.
 */
export function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [apps, setApps] = useState<readonly AdminApp[] | null>(null);
  const [users, setUsers] = useState<readonly AdminUser[] | null>(null);
  const [stops, setStops] = useState<readonly AdminStop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Alla fyra anropen tillsammans: vyn visar ingenting förrän den har hela bilden, och ett nekat
    // anrop ska ge ett besked — inte en halv sida.
    Promise.all([api.adminOverview(), api.adminApps(), api.adminUsers(), api.adminStops()]).then(
      ([nextOverview, nextApps, nextUsers, nextStops]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setApps(nextApps);
        setUsers(nextUsers);
        setStops(nextStops);
      },
      (caught: unknown) => {
        if (!cancelled) setError(adminErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Efter en ändring är listan sanningen. Siffrorna räknas om ur den, så att panelen och tabellen
   * på samma sida inte säger olika saker.
   */
  function accept(user: AdminUser): { next: readonly AdminUser[]; existed: boolean } {
    const current = users ?? [];
    const existed = current.some((row) => row.userId === user.userId);
    const next = withUser(current, user);
    setUsers(next);
    setOverview((previous) => (previous === null ? previous : { ...previous, users: countRoles(next) }));
    return { next, existed };
  }

  async function invite(email: string, role: Role): Promise<string> {
    const user = await api.adminInvite(email, role);
    const { existed } = accept(user);
    return invitedMessage(user, existed);
  }

  async function setRole(userId: string, role: Role): Promise<string> {
    const user = await api.adminSetRole(userId, role);
    accept(user);
    return roleChangedMessage(user);
  }

  return (
    <AdminView
      overview={overview}
      apps={apps}
      users={users}
      stops={stops}
      error={error}
      onInvite={(email, role) => invite(email, role)}
      onSetRole={(userId, role) => setRole(userId, role)}
    />
  );
}

export interface AdminViewProps {
  readonly overview: AdminOverview | null;
  readonly apps: readonly AdminApp[] | null;
  readonly users: readonly AdminUser[] | null;
  readonly stops: readonly AdminStop[] | null;
  readonly error: string | null;
  /** Löser ut med beskedet att visa; kastar serverns fel, som vyn översätter till klarspråk. */
  readonly onInvite: (email: string, role: Role) => Promise<string>;
  readonly onSetRole: (userId: string, role: Role) => Promise<string>;
}

export function AdminView({ overview, apps, users, stops, error, onInvite, onSetRole }: AdminViewProps) {
  return (
    <div className="page page-admin">
      <h1>{ADMIN_TITLE}</h1>
      <p className="hint">{ADMIN_LEAD}</p>

      {error !== null ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : overview === null || apps === null || users === null || stops === null ? (
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
              {/* Adresserna som får logga in, per roll. Rollerna med sina svenska namn, samma
                  ord som i listan längre ned — annars ser det ut som två olika saker. */}
              {ROLES.map((role) => (
                <Figure key={role} label={roleLabel(role)} value={overview.users[role]} />
              ))}
            </dl>
            <p className="hint">{ADMIN_TOKENS_NOTE}</p>
          </section>

          <section className="admin-block" aria-labelledby="admin-apps-heading">
            <h2 id="admin-apps-heading">{ADMIN_APPS_HEADING}</h2>
            <p className="hint">{ADMIN_ID_NOTE}</p>
            {apps.length === 0 ? <p className="muted">{ADMIN_EMPTY}</p> : <AppTable apps={apps} />}
          </section>

          <UsersSection users={users} onInvite={onInvite} onSetRole={onSetRole} />

          <StopsSection stops={stops} />
        </>
      )}
    </div>
  );
}

/**
 * Stoppade önskemål. Ren läsning, och medvetet utan länk: ett stopp hör till appen, men
 * kontrollrummet är ingen väg in i den. Önskemålets text finns inte i kontraktet och efterfrågas
 * därför aldrig — den kan bära personuppgifter.
 */
function StopsSection({ stops }: { stops: readonly AdminStop[] }) {
  const counts = countStops(stops);
  return (
    <section className="admin-block" aria-labelledby="admin-stops-heading">
      <h2 id="admin-stops-heading">{ADMIN_STOPS_HEADING}</h2>
      <p className="hint">{ADMIN_STOPS_PRIVACY_NOTE}</p>
      <p className="hint">{ADMIN_STOPS_PATTERN_NOTE}</p>
      {counts.length === 0 ? (
        <p className="muted">{ADMIN_STOPS_EMPTY}</p>
      ) : (
        <table className="admin-table admin-stops">
          <caption className="visually-hidden">Gränser som stoppat önskemål, den vanligaste först</caption>
          <thead>
            <tr>
              <th scope="col">Gräns</th>
              <th scope="col">Vad den betyder</th>
              <th scope="col" className="admin-num">Antal</th>
            </tr>
          </thead>
          <tbody>
            {counts.map(({ category, count }) => (
              <tr key={category}>
                <th scope="row">{REDLINE_TEXTS[category].label}</th>
                <td>{REDLINE_TEXTS[category].explanation}</td>
                <td className="admin-num">{count === 1 ? '1 gång' : `${formatCount(count)} gånger`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

/** Kontrollrummets tredje del: vilka som får logga in, och med vilken roll. */
function UsersSection({
  users,
  onInvite,
  onSetRole,
}: {
  users: readonly AdminUser[];
  onInvite: AdminViewProps['onInvite'];
  onSetRole: AdminViewProps['onSetRole'];
}) {
  return (
    <section className="admin-block" aria-labelledby="admin-users-heading">
      <h2 id="admin-users-heading">{ADMIN_USERS_HEADING}</h2>
      <p className="hint">{ADMIN_USERS_LEAD}</p>

      {/* Vad de tre rollerna får göra. Sagt en gång, här — skillnaden mellan dem är inte
          självklar, och den som väljer roll åt en kollega behöver veta det innan hen väljer. */}
      <dl className="admin-roles">
        {ROLES.map((role) => (
          <div className="admin-role" key={role}>
            <dt>{ROLE_TEXTS[role].label}</dt>
            <dd>{ROLE_TEXTS[role].explanation}</dd>
          </div>
        ))}
      </dl>

      <InviteForm onInvite={onInvite} />
      <UserTable users={users} onSetRole={onSetRole} />
    </section>
  );
}

function InviteForm({ onInvite }: { onInvite: AdminViewProps['onInvite'] }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('builder');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const emailId = useId();
  const roleId = useId();
  const resultId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const checked = validateInviteEmail(email);
    if (!checked.ok) {
      setResult({ ok: false, message: checked.message });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const message = await onInvite(checked.email, role);
      // Rutan töms först nu: går anropet fel står adressen kvar, och går att skicka om.
      setEmail('');
      setResult({ ok: true, message });
    } catch (caught) {
      setResult({ ok: false, message: inviteErrorMessage(caught) });
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="admin-invite" onSubmit={(event) => void submit(event)} noValidate>
      <h3>{ADMIN_INVITE_HEADING}</h3>
      <p className="hint">{ADMIN_INVITE_NOTE}</p>
      <div className="admin-invite-row">
        <div className="admin-field">
          <label className="field-label" htmlFor={emailId}>
            {ADMIN_INVITE_EMAIL_LABEL}
          </label>
          <input
            id={emailId}
            className="input"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={result !== null && !result.ok}
            aria-describedby={resultId}
            disabled={sending}
          />
        </div>
        <div className="admin-field admin-field-role">
          <label className="field-label" htmlFor={roleId}>
            {ADMIN_INVITE_ROLE_LABEL}
          </label>
          <select
            id={roleId}
            className="input admin-select"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={sending}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? ADMIN_INVITE_SENDING : ADMIN_INVITE_BUTTON}
        </button>
      </div>
      <p id={resultId} className={result?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
        {result?.message ?? ''}
      </p>
    </form>
  );
}

/**
 * Adressen är radens rubrik (`th scope="row"`), så att en skärmläsare kan knyta varje cell till
 * rätt person. Adressen står BARA där och i beskedet efter en ändring — aldrig i ett `aria-label`,
 * en `title` eller ett `id`, eftersom sådant följer med i uppläsningen utan att någon bett om det.
 */
function UserTable({ users, onSetRole }: { users: readonly AdminUser[]; onSetRole: AdminViewProps['onSetRole'] }) {
  return (
    <div className="admin-table-scroll" role="region" aria-label={ADMIN_USERS_HEADING} tabIndex={0}>
      <table className="admin-table">
        <caption className="visually-hidden">Alla adresser som får logga in i plattformen</caption>
        <thead>
          <tr>
            <th scope="col">{ADMIN_USERS_COLUMNS.email}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.role}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.created}</th>
            <th scope="col">{ADMIN_USERS_COLUMNS.change}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.userId}>
              <th scope="row" className="admin-user-email">
                {user.email}
              </th>
              <td>
                <span className="badge">{roleLabel(user.role)}</span>
              </td>
              <td>{user.createdAt === null ? ADMIN_DATE_UNKNOWN : formatUpdated(user.createdAt)}</td>
              <td>
                {user.self ? (
                  // Ingen knapp, inte ens en inaktiverad: en knapp som bara kan misslyckas är ett
                  // löfte vyn inte kan hålla. I stället står det varför raden ser annorlunda ut.
                  <p className="admin-self-note">{ADMIN_SELF_NOTE}</p>
                ) : (
                  <RoleForm user={user} onSetRole={onSetRole} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleForm({ user, onSetRole }: { user: AdminUser; onSetRole: AdminViewProps['onSetRole'] }) {
  const [role, setRole] = useState<Role>(user.role);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const selectId = useId();
  const resultId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || role === user.role) return;
    setSaving(true);
    setResult(null);
    try {
      const message = await onSetRole(user.userId, role);
      setResult({ ok: true, message });
    } catch (caught) {
      // Menyn ställs tillbaka: raden ska läsas som den ÄR, inte som någon hoppades att den blev.
      setRole(user.role);
      setResult({ ok: false, message: roleErrorMessage(caught) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="admin-role-form" onSubmit={(event) => void submit(event)}>
      {/* Etiketten är dold för ögat men läses upp. Den säger "den här raden", aldrig adressen:
          radrubriken ger skärmläsaren personen, och adressen behöver inte upprepas i ett attribut. */}
      <label className="visually-hidden" htmlFor={selectId}>
        {ADMIN_ROLE_SELECT_LABEL}
      </label>
      <select
        id={selectId}
        className="input admin-select"
        value={role}
        disabled={saving}
        aria-describedby={resultId}
        onChange={(event) => setRole(event.target.value as Role)}
      >
        {ROLES.map((value) => (
          <option key={value} value={value}>
            {roleLabel(value)}
          </option>
        ))}
      </select>
      <button type="submit" className="button button-role" disabled={saving || role === user.role}>
        {saving ? ADMIN_ROLE_SAVING : ADMIN_ROLE_BUTTON}
      </button>
      <p
        id={resultId}
        className={result?.ok === false ? 'status-line status-error' : 'status-line'}
        aria-live="polite"
      >
        {result?.message ?? ''}
      </p>
    </form>
  );
}
